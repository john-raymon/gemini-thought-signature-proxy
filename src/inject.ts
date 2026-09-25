import { SignatureCache } from "./cache.js";
import { BYPASS_SIGNATURE } from "./config.js";
import type { OpenAIMessage, OpenAIToolCall } from "./types.js";

/**
 * Reads a thought signature from a tool call, checking Google's documented
 * wire location first (extra_content.google.thought_signature) and the
 * top-level fallback some clients/LiteLLM-style proxies emit. Returns null
 * when no usable signature exists. Shared with the response extractors.
 */
export function extractThoughtSignature(tc: unknown): string | null {
  if (typeof tc !== "object" || tc === null) return null;
  const record = tc as Record<string, unknown>;

  const extra = record["extra_content"];
  if (typeof extra === "object" && extra !== null) {
    const google = (extra as Record<string, unknown>)["google"];
    if (typeof google === "object" && google !== null) {
      const sig = (google as Record<string, unknown>)["thought_signature"];
      if (typeof sig === "string" && sig.trim().length > 0) return sig.trim();
    }
  }

  const top = record["thought_signature"];
  if (typeof top === "string" && top.trim().length > 0) return top.trim();

  return null;
}

function hasDocumentedSignature(tc: OpenAIToolCall): boolean {
  const sig = tc.extra_content?.google?.thought_signature;
  return typeof sig === "string" && sig.trim().length > 0;
}

/**
 * Merges a thought signature into extra_content.google.thought_signature
 * without dropping sibling keys and without assuming extra_content/google
 * are objects (defensive against malformed client payloads).
 */
function withThoughtSignature(tc: OpenAIToolCall, signature: string): OpenAIToolCall {
  const extra =
    typeof tc.extra_content === "object" && tc.extra_content !== null ? { ...tc.extra_content } : {};
  const googleRaw = (tc.extra_content as Record<string, unknown> | undefined)?.["google"];
  const google =
    typeof googleRaw === "object" && googleRaw !== null ? { ...googleRaw } : {};

  return {
    ...tc,
    extra_content: {
      ...extra,
      google: {
        ...google,
        thought_signature: signature,
      },
    },
  };
}

type PatchOutcome = { patched: OpenAIToolCall; changed: boolean };

function patchToolCall(
  tc: OpenAIToolCall,
  cache: SignatureCache,
  shouldPatchModel: (model?: unknown) => boolean,
  model: unknown,
): PatchOutcome {
  const pass: PatchOutcome = { patched: tc, changed: false };

  if (typeof tc !== "object" || tc === null) return pass;
  if (typeof tc.id !== "string" || tc.id.length === 0) return pass;

  const existing = extractThoughtSignature(tc);
  if (existing !== null) {
    // Signature present at the documented location — never touch it.
    if (hasDocumentedSignature(tc)) return pass;
    // Signature only at the top-level fallback location (clobber guard):
    // promote it into the documented location for gemini-matching models
    // instead of letting the sentinel path overwrite a real signature.
    if (shouldPatchModel(model)) {
      return { patched: withThoughtSignature(tc, existing), changed: true };
    }
    return pass;
  }

  const lookup = cache.get(tc.id);
  switch (lookup.state) {
    case "signed":
      return { patched: withThoughtSignature(tc, lookup.value), changed: true };
    case "unsigned":
      // Known parallel sibling: Gemini signs only the first part and expects
      // siblings back exactly as received — unsigned.
      return pass;
    case "miss":
      if (shouldPatchModel(model)) {
        return { patched: withThoughtSignature(tc, BYPASS_SIGNATURE), changed: true };
      }
      return pass;
  }
}

/**
 * Patches assistant tool_calls in a messages array with cached real
 * signatures (or the bypass sentinel on cache miss for gemini-matching
 * models). Non-mutating: returns the ORIGINAL array reference when nothing
 * changed, so callers can cheaply detect no-ops.
 */
export function patchMessages(
  messages: OpenAIMessage[] | undefined,
  cache: SignatureCache,
  shouldPatchModel: (model?: unknown) => boolean,
  model?: unknown,
): OpenAIMessage[] | undefined {
  if (!Array.isArray(messages)) return messages;

  let messagesChanged = false;
  const result: OpenAIMessage[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (
      typeof message !== "object" ||
      message === null ||
      message.role !== "assistant" ||
      !Array.isArray(message.tool_calls)
    ) {
      result[i] = message;
      continue;
    }

    let messageChanged = false;
    const toolCalls = message.tool_calls;
    const patchedToolCalls: OpenAIToolCall[] = new Array(toolCalls.length);
    for (let j = 0; j < toolCalls.length; j++) {
      const outcome = patchToolCall(toolCalls[j], cache, shouldPatchModel, model);
      patchedToolCalls[j] = outcome.patched;
      if (outcome.changed) messageChanged = true;
    }

    if (messageChanged) {
      messagesChanged = true;
      result[i] = { ...message, tool_calls: patchedToolCalls };
    } else {
      result[i] = message;
    }
  }

  return messagesChanged ? result : messages;
}

/**
 * Whole-body convenience wrapper for route handlers: patches body.messages
 * using body.model for sentinel gating. Returns the ORIGINAL body reference
 * when nothing changed.
 */
export function patchRequestBody<T extends Record<string, unknown>>(
  body: T,
  cache: SignatureCache,
  shouldPatchModel: (model?: unknown) => boolean,
): T {
  if (typeof body !== "object" || body === null || !Array.isArray(body["messages"])) {
    return body;
  }

  const messages = body["messages"] as OpenAIMessage[];
  const patched = patchMessages(messages, cache, shouldPatchModel, body["model"]);
  if (patched === messages) return body;

  return { ...body, messages: patched };
}
