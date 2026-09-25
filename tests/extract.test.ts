import { describe, expect, it } from "vitest";
import { SignatureCache } from "../src/cache.js";
import { extractFromJsonResponse, SseSignatureExtractor } from "../src/extract.js";

function makeCache(entries?: Record<string, string | null>) {
  const cache = new SignatureCache({ maxEntries: 100, ttlMs: 60_000, sweepIntervalMs: null });
  for (const [id, value] of Object.entries(entries ?? {})) cache.set(id, value);
  return cache;
}

function jsonChoice(
  toolCalls: unknown[] | undefined,
  location: "message" | "delta" = "message",
  index = 0,
) {
  return { index, [location]: { role: "assistant", tool_calls: toolCalls } };
}

describe("extractFromJsonResponse", () => {
  it("caches a single signed tool call", () => {
    const cache = makeCache();
    const stats = extractFromJsonResponse(
      {
        choices: [
          jsonChoice([
            {
              id: "call_a",
              extra_content: { google: { thought_signature: "sigA" } },
            },
          ]),
        ],
      },
      cache,
    );
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sigA" });
    expect(stats).toEqual({ signed: 1, unsigned: 0 });
  });

  it("caches parallel signed + unsigned siblings in one choice", () => {
    const cache = makeCache();
    const stats = extractFromJsonResponse(
      {
        choices: [
          jsonChoice([
            { id: "call_a", extra_content: { google: { thought_signature: "sigA" } } },
            { id: "call_b" }, // sibling — must go back unsigned
          ]),
        ],
      },
      cache,
    );
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sigA" });
    expect(cache.get("call_b")).toEqual({ state: "unsigned" });
    expect(stats).toEqual({ signed: 1, unsigned: 1 });
  });

  it("caches nothing for a zero-signature choice", () => {
    const cache = makeCache();
    const stats = extractFromJsonResponse(
      { choices: [jsonChoice([{ id: "call_a" }, { id: "call_b" }])] },
      cache,
    );
    expect(cache.size).toBe(0);
    expect(stats).toEqual({ signed: 0, unsigned: 0 });
  });

  it("applies the sibling rule per choice, not globally", () => {
    const cache = makeCache();
    extractFromJsonResponse(
      {
        choices: [
          jsonChoice([{ id: "call_0", extra_content: { google: { thought_signature: "s" } } }, { id: "call_1" }], "message", 0),
          jsonChoice([{ id: "call_2" }], "message", 1), // zero sigs -> nothing
        ],
      },
      cache,
    );
    expect(cache.get("call_0").state).toBe("signed");
    expect(cache.get("call_1")).toEqual({ state: "unsigned" });
    expect(cache.get("call_2")).toEqual({ state: "miss" });
    expect(cache.size).toBe(2);
  });

  it("reads tool_calls from choice.delta as a fallback", () => {
    const cache = makeCache();
    const stats = extractFromJsonResponse(
      { choices: [jsonChoice([{ id: "call_a", thought_signature: "topSig" }], "delta")] },
      cache,
    );
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "topSig" });
    expect(stats.signed).toBe(1);
  });

  it("never throws on malformed payloads and caches nothing", () => {
    const junk: unknown[] = [
      null,
      undefined,
      "str",
      42,
      {},
      { choices: "nope" },
      { choices: [null, "x"] },
      { choices: [{ message: null }] },
      { choices: [{ message: { tool_calls: "nope" } }] },
      { choices: [{ message: { tool_calls: [null, 42, {}, { id: "" }] } }] },
    ];
    for (const body of junk) {
      const cache = makeCache();
      expect(() => extractFromJsonResponse(body, cache)).not.toThrow();
      expect(cache.size).toBe(0);
    }
  });

  it("a real signature upgrades a previously cached unsigned sibling", () => {
    const cache = makeCache({ call_a: null });
    extractFromJsonResponse(
      { choices: [jsonChoice([{ id: "call_a", thought_signature: "realSig" }])] },
      cache,
    );
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "realSig" });
  });
});

// ---------------------------------------------------------------------------
// SSE extractor
// ---------------------------------------------------------------------------

function sseDelta(choiceIndex: number, toolCalls: unknown[]): string {
  return JSON.stringify({ choices: [{ index: choiceIndex, delta: { tool_calls: toolCalls } }] });
}

function frame(payload: string, eol = "\n\n"): string {
  return `data: ${payload}${eol}`;
}

const DONE_LF = "data: [DONE]\n\n";
const DONE_CRLF = "data: [DONE]\r\n\r\n";

const FIRST_DELTA = sseDelta(0, [
  {
    index: 0,
    id: "call_A",
    type: "function",
    function: { name: "f1", arguments: "" },
    extra_content: { google: { thought_signature: "sig_123" } },
  },
]);
const SIBLING_DELTA = sseDelta(0, [
  { index: 1, id: "call_B", type: "function", function: { name: "f2", arguments: "" } },
]);

describe("SseSignatureExtractor — framing", () => {
  it("commits on [DONE] with LF framing", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + frame(SIBLING_DELTA) + DONE_LF);
    // Committed immediately at [DONE] — before finish().
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
    expect(cache.get("call_B")).toEqual({ state: "unsigned" });
    expect(extractor.finish()).toEqual({ signed: 1, unsigned: 1 });
  });

  it("commits on [DONE] with CRLF framing", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA, "\r\n\r\n") + DONE_CRLF);
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });

  it("re-assembles frames split mid-frame (7-byte slices)", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const stream = frame(FIRST_DELTA, "\r\n\r\n") + frame(SIBLING_DELTA, "\r\n\r\n") + DONE_CRLF;
    for (let i = 0; i < stream.length; i += 7) {
      extractor.feed(stream.slice(i, i + 7));
    }
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
    expect(cache.get("call_B")).toEqual({ state: "unsigned" });
    expect(extractor.finish()).toEqual({ signed: 1, unsigned: 1 });
  });

  it("handles 'data:payload' without a space + comment-only frames", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(`data:${FIRST_DELTA}\n\n: keep-alive\n\n` + DONE_LF);
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });

  it("skips non-tool-call text deltas via the cheap guard", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const textDelta = frame(JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] }));
    extractor.feed(textDelta + frame(FIRST_DELTA) + DONE_LF);
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });

  it("ignores malformed JSON frames and keeps going", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(
      frame("data: {not json but tool_calls") + frame(FIRST_DELTA) + DONE_LF,
    );
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });
});

describe("SseSignatureExtractor — accumulation & sibling rule", () => {
  it("captures id on first delta and signature on a later delta of the same index", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const first = sseDelta(0, [{ index: 0, id: "call_late", function: { name: "f" } }]);
    const second = sseDelta(0, [
      { index: 0, extra_content: { google: { thought_signature: "lateSig" } } },
    ]);
    extractor.feed(frame(first) + frame(second) + DONE_LF);
    expect(cache.get("call_late")).toEqual({ state: "signed", value: "lateSig" });
  });

  it("supports top-level thought_signature wire path", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const delta = sseDelta(0, [{ index: 0, id: "call_top", thought_signature: "topSig" }]);
    extractor.feed(frame(delta) + DONE_LF);
    expect(cache.get("call_top")).toEqual({ state: "signed", value: "topSig" });
  });

  it("caches nothing for a zero-signature choice even with [DONE]", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(SIBLING_DELTA) + DONE_LF);
    expect(cache.size).toBe(0);
    expect(extractor.finish()).toEqual({ signed: 0, unsigned: 0 });
  });

describe("SseSignatureExtractor — finish semantics", () => {
  it("discards accumulators when the stream ends without [DONE]", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + frame(SIBLING_DELTA));
    const stats = extractor.finish();
    expect(stats).toEqual({ signed: 0, unsigned: 0 });
    expect(cache.size).toBe(0);
  });

  it("flushes a trailing bare '[DONE]' line at EOF", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + "data: [DONE]"); // no trailing newlines
    const stats = extractor.finish();
    expect(stats).toEqual({ signed: 1, unsigned: 0 });
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });

  it("finish() is idempotent and feed() after finish() is a no-op", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + DONE_LF);
    const first = extractor.finish();
    const second = extractor.finish();
    expect(second).toEqual(first);
    extractor.feed(frame(SIBLING_DELTA)); // must be ignored
    expect(cache.get("call_B")).toEqual({ state: "miss" });
  });

  it("a second [DONE] frame commits empty without errors", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + DONE_LF + DONE_LF);
    expect(extractor.finish()).toEqual({ signed: 1, unsigned: 0 });
  });

  it("no timers leak from caches used by extractors", async () => {
    const { default: process } = await import("node:process");
    const before = (process as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + DONE_LF);
    extractor.finish();
    const after = (process as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});

  it("isolates the sibling rule per choice index", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const choice0 = sseDelta(0, [
      { index: 0, id: "call_0", extra_content: { google: { thought_signature: "s0" } } },
      { index: 1, id: "call_1" },
    ]);
    const choice1 = sseDelta(1, [{ index: 0, id: "call_2" }]);
    extractor.feed(frame(choice0) + frame(choice1) + DONE_LF);
    expect(cache.get("call_0")).toEqual({ state: "signed", value: "s0" });
    expect(cache.get("call_1")).toEqual({ state: "unsigned" });
    expect(cache.get("call_2")).toEqual({ state: "miss" });
  });

  it("never caches a tool call whose id never arrived", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const idless = sseDelta(0, [
      { index: 0, extra_content: { google: { thought_signature: "orphan" } } },
    ]);
    extractor.feed(frame(idless) + DONE_LF);
    expect(cache.size).toBe(0);
    expect(extractor.finish()).toEqual({ signed: 0, unsigned: 0 });
  });

  it("does not collapse multiple index-less tool calls into one accumulator", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    const delta = sseDelta(0, [
      { id: "call_noidx_a", extra_content: { google: { thought_signature: "sigA" } } },
      { id: "call_noidx_b" },
    ]);
    extractor.feed(frame(delta) + DONE_LF);
    expect(cache.get("call_noidx_a")).toEqual({ state: "signed", value: "sigA" });
    expect(cache.get("call_noidx_b")).toEqual({ state: "unsigned" });
  });

  it("flushes non-canonical 'data:[DONE]' variants at abrupt EOF", () => {
    const cache = makeCache();
    const extractor = new SseSignatureExtractor(cache);
    extractor.feed(frame(FIRST_DELTA) + "data:[DONE]"); // no space, no trailing newlines
    expect(extractor.finish()).toEqual({ signed: 1, unsigned: 0 });
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });
});
