import type { SignatureCache } from "./cache.js";
import { extractThoughtSignature } from "./inject.js";

/** How many cache entries an extraction pass committed. */
export interface ExtractionStats {
  signed: number;
  unsigned: number;
}

function zeroStats(): ExtractionStats {
  return { signed: 0, unsigned: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  // typeof null === 'object' — always pair the checks.
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Commits one choice's tool calls to the cache, applying the sibling-null
 * rule: Gemini signs only the first tool-call part of a parallel batch, so
 * "unsigned sibling" (null) is a meaningful state ONLY when at least one
 * tool call in the same choice carried a real signature. A choice with zero
 * signatures is not a parallel batch — caching nulls there would wrongly
 * suppress the sentinel fallback on the next turn.
 */
function commitToolCallGroup(
  toolCalls: unknown[],
  cache: SignatureCache,
  stats: ExtractionStats,
): void {
  const collected: Array<{ id: string; signature: string | null }> = [];
  for (const raw of toolCalls) {
    const tc = asRecord(raw);
    if (tc === null) continue;
    const id = tc["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    collected.push({ id, signature: extractThoughtSignature(tc) });
  }
  if (!collected.some((entry) => entry.signature !== null)) return;

  for (const { id, signature } of collected) {
    cache.set(id, signature);
    if (signature === null) stats.unsigned += 1;
    else stats.signed += 1;
  }
}

/**
 * Extracts thought signatures from a non-streaming (JSON) chat completion
 * response. Reads choice.message.tool_calls, falling back to choice.delta
 * for non-conforming gateways. Never throws on malformed payloads; returns
 * commit stats for logging/tests.
 */
export function extractFromJsonResponse(body: unknown, cache: SignatureCache): ExtractionStats {
  const stats = zeroStats();
  const root = asRecord(body);
  if (root === null) return stats;

  const choices = root["choices"];
  if (!Array.isArray(choices)) return stats;

  for (const rawChoice of choices) {
    const choice = asRecord(rawChoice);
    if (choice === null) continue;

    const message = asRecord(choice["message"]);
    const delta = asRecord(choice["delta"]);
    const toolCalls =
      (Array.isArray(message?.["tool_calls"]) ? message?.["tool_calls"] : undefined) ??
      (Array.isArray(delta?.["tool_calls"]) ? delta?.["tool_calls"] : undefined);
    if (!Array.isArray(toolCalls)) continue;

    commitToolCallGroup(toolCalls, cache, stats);
  }

  return stats;
}

/** Accumulator for one streaming tool call, keyed by (choice, tool-call) index. */
interface SseAccumulator {
  id?: string;
  signature?: string;
}

/**
 * Incremental thought-signature extractor for OpenAI-format SSE streams.
 *
 * feed() raw text as chunks arrive (any split point — mid-frame, mid-line);
 * complete frames are parsed as they close. Signatures commit to the cache
 * the moment `data: [DONE]` is seen, because clients commonly abort the
 * downstream connection immediately after [DONE] and finish() may be too
 * late. A stream that ends WITHOUT [DONE] is treated as aborted mid-turn:
 * finish() discards all accumulators rather than caching speculative nulls.
 */
export class SseSignatureExtractor {
  private readonly cache: SignatureCache;
  private remainder = "";
  private doneSeen = false;
  private finished = false;
  private committedStats: ExtractionStats = zeroStats();
  private readonly choices = new Map<number, Map<number, SseAccumulator>>();

  constructor(cache: SignatureCache) {
    this.cache = cache;
  }

  feed(text: string): void {
    if (this.finished || this.doneSeen) return;
    this.remainder += text;

    const boundary = /\r?\n\r?\n/;
    let match = boundary.exec(this.remainder);
    while (match !== null) {
      const frame = this.remainder.slice(0, match.index);
      this.remainder = this.remainder.slice(match.index + match[0].length);
      this.processFrame(frame);
      if (this.doneSeen) return;
      match = boundary.exec(this.remainder);
    }
  }

  /**
   * Idempotent end-of-stream hook. If the connection dropped right after a
   * bare `data: [DONE]` line (no trailing newlines), flush it so the commit
   * still happens; otherwise discard and return zero stats.
   */
  finish(): ExtractionStats {
    if (this.finished) return this.committedStats;
    // Flush ANY non-empty tail: providers emit 'data:[DONE]' variants (no
    // space, extra spaces) and some drop the trailing newlines at abrupt
    // EOF. If it's a [DONE] variant, processFrame commits; if it's a
    // truncated frame, the parse fails and we hit the discard path below.
    if (!this.doneSeen && this.remainder.trim().length > 0) {
      this.feed("\n\n");
    }
    this.finished = true;
    if (!this.doneSeen) {
      this.choices.clear();
      this.remainder = "";
      return zeroStats();
    }
    return this.committedStats;
  }

  private processFrame(frame: string): void {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue; // skip event:/id:/retry:/comments
      // Strip "data:" plus at most one leading space (SSE spec).
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return;

    const joined = dataLines.join("\n");
    const trimmed = joined.trim();

    // Order matters: [DONE] must be detected BEFORE the cheap skip-guard,
    // or commits would never fire.
    if (trimmed === "[DONE]") {
      this.doneSeen = true;
      this.committedStats = this.commit();
      return;
    }
    if (!trimmed.includes("tool_calls") && !trimmed.includes("thought_signature")) return;
    try {
      this.accumulate(JSON.parse(joined));
    } catch {
      // Malformed upstream frame: skip it, keep the stream going.
    }
  }

  private accumulate(chunk: unknown): void {
    const root = asRecord(chunk);
    if (root === null) return;
    const choices = root["choices"];
    if (!Array.isArray(choices)) return;

    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      if (choice === null) continue;
      const choiceIndex = typeof choice["index"] === "number" ? (choice["index"] as number) : 0;
      const delta = asRecord(choice["delta"]);
      const toolCalls = delta?.["tool_calls"];
      if (!Array.isArray(toolCalls)) continue;

      let group = this.choices.get(choiceIndex);
      if (group === undefined) {
        group = new Map();
        this.choices.set(choiceIndex, group);
      }

      // Keyed by index, never by id: id only appears on the first delta of
      // a tool call; later deltas reference the same index without it. When
      // a provider omits `index`, fall back to the array position so
      // multiple index-less tool calls don't collapse into one accumulator.
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = asRecord(toolCalls[i]);
        if (tc === null) continue;
        const tcIndex = typeof tc["index"] === "number" ? (tc["index"] as number) : i;

        let acc = group.get(tcIndex);
        if (acc === undefined) {
          acc = {};
          group.set(tcIndex, acc);
        }

        const id = tc["id"];
        if (acc.id === undefined && typeof id === "string" && id.length > 0) {
          acc.id = id;
        }
        if (acc.signature === undefined) {
          const sig = extractThoughtSignature(tc);
          if (sig !== null) acc.signature = sig;
        }
      }
    }
  }

  private commit(): ExtractionStats {
    const stats = zeroStats();
    for (const group of this.choices.values()) {
      const anySigned = Array.from(group.values()).some((acc) => acc.signature !== undefined);
      if (!anySigned) continue; // sibling-null rule, per choice
      for (const acc of group.values()) {
        if (acc.id === undefined) continue;
        this.cache.set(acc.id, acc.signature ?? null);
        if (acc.signature === undefined) stats.unsigned += 1;
        else stats.signed += 1;
      }
    }
    this.choices.clear();
    this.remainder = "";
    return stats;
  }
}

