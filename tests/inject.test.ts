import { describe, expect, it } from "vitest";
import { SignatureCache } from "../src/cache.js";
import { BYPASS_SIGNATURE } from "../src/config.js";
import {
  extractThoughtSignature,
  patchMessages,
  patchRequestBody,
} from "../src/inject.js";
import type { OpenAIMessage, OpenAIToolCall } from "../src/types.js";

const GEMINI = "models/gemini-3.8-flash";
const NOT_GEMINI = "gpt-4o";
const matchAll = () => true;
const matchNone = () => false;

function makeCache(entries?: Record<string, string | null>) {
  const cache = new SignatureCache({ maxEntries: 100, ttlMs: 60_000, sweepIntervalMs: null });
  for (const [id, value] of Object.entries(entries ?? {})) cache.set(id, value);
  return cache;
}

function toolCall(id: string, extra?: Partial<OpenAIToolCall>): OpenAIToolCall {
  return { id, type: "function", function: { name: "f", arguments: "{}" }, ...extra };
}

function assistantWith(toolCalls: OpenAIToolCall[]): OpenAIMessage {
  return { role: "assistant", content: null, tool_calls: toolCalls };
}

function getSignature(tc: unknown): string | undefined {
  const google = (tc as OpenAIToolCall).extra_content?.google as
    | Record<string, unknown>
    | undefined;
  return google?.["thought_signature"] as string | undefined;
}

describe("extractThoughtSignature", () => {
  it("reads the documented wire location", () => {
    const tc = toolCall("a", {
      extra_content: { google: { thought_signature: "sig" } },
    });
    expect(extractThoughtSignature(tc)).toBe("sig");
  });

  it("reads the top-level fallback location", () => {
    expect(extractThoughtSignature(toolCall("a", { thought_signature: "topSig" }))).toBe("topSig");
  });

  it("returns null for junk input", () => {
    expect(extractThoughtSignature(null)).toBeNull();
    expect(extractThoughtSignature("x")).toBeNull();
    expect(extractThoughtSignature({})).toBeNull();
    expect(extractThoughtSignature({ thought_signature: "   " })).toBeNull();
  });
});

describe("patchMessages — pass-through cases", () => {
  it("returns non-array input unchanged", () => {
    const cache = makeCache();
    expect(patchMessages(undefined, cache, matchAll, GEMINI)).toBeUndefined();
    const junk = { not: "messages" } as unknown as OpenAIMessage[];
    expect(patchMessages(junk, cache, matchAll, GEMINI)).toBe(junk);
  });

  it("leaves non-assistant and tool_call-less messages untouched", () => {
    const cache = makeCache();
    const messages: OpenAIMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "no tools" },
      { role: "tool", tool_call_id: "call_a", content: "result" },
    ];
    expect(patchMessages(messages, cache, matchAll, GEMINI)).toBe(messages);
  });

  it("passes malformed tool_call entries through safely", () => {
    const cache = makeCache();
    const messages: OpenAIMessage[] = [
      assistantWith([null, undefined, "x", 42] as unknown as OpenAIToolCall[]),
      assistantWith([{ type: "function" } as OpenAIToolCall]), // no id
      assistantWith([toolCall("")]), // empty id
    ];
    const patched = patchMessages(messages, cache, matchAll, GEMINI);
    expect(patched).toBe(messages);
  });

  it("never overwrites an already-present documented signature", () => {
    const cache = makeCache({ call_a: "cachedSig" });
    const messages = [
      assistantWith([
        toolCall("call_a", { extra_content: { google: { thought_signature: "clientSig" } } }),
      ]),
    ];
    expect(patchMessages(messages, cache, matchAll, GEMINI)).toBe(messages);
  });
});


describe("patchMessages — cache-driven injection", () => {
  it("injects the real cached signature on a signed hit", () => {
    const cache = makeCache({ call_a: "realSig" });
    const patched = patchMessages(
      [assistantWith([toolCall("call_a")])],
      cache,
      matchNone,
      NOT_GEMINI, // model gate must NOT block real-signature injection
    );
    expect(getSignature(patched![0].tool_calls![0])).toBe("realSig");
  });

  it("preserves sibling extra_content keys when injecting", () => {
    const cache = makeCache({ call_a: "realSig" });
    const tc = toolCall("call_a", {
      extra_content: { google: { other_flag: true }, other_ns: { x: 1 } },
    });
    const patched = patchMessages([assistantWith([tc])], cache, matchAll, GEMINI);
    const injected = patched![0].tool_calls![0];
    expect(getSignature(injected)).toBe("realSig");
    expect(injected.extra_content?.google?.["other_flag"]).toBe(true);
    expect(injected.extra_content?.["other_ns"]).toEqual({ x: 1 });
    expect(injected.id).toBe("call_a"); // other fields intact
  });

  it("tolerates primitive/malformed extra_content without throwing", () => {
    const cache = makeCache({ call_a: "realSig" });
    const messages = [
      assistantWith([toolCall("call_a", { extra_content: "junk" as never })]),
      assistantWith([toolCall("call_a", { extra_content: null as never })]),
    ];
    const patched = patchMessages(messages, cache, matchAll, GEMINI)!;
    expect(getSignature(patched[0].tool_calls![0])).toBe("realSig");
    expect(getSignature(patched[1].tool_calls![0])).toBe("realSig");
  });

  it("leaves known-unsigned siblings alone even when the model matches", () => {
    const cache = makeCache({ call_a: "realSig", call_b: null });
    const patched = patchMessages(
      [assistantWith([toolCall("call_a"), toolCall("call_b")])],
      cache,
      matchAll,
      GEMINI,
    )!;
    expect(getSignature(patched[0].tool_calls![0])).toBe("realSig");
    expect(getSignature(patched[0].tool_calls![1])).toBeUndefined();
  });

  it("injects the bypass sentinel on cache miss for matching models only", () => {
    const geminiPatched = patchMessages(
      [assistantWith([toolCall("call_unknown")])],
      makeCache(),
      matchAll,
      GEMINI,
    )!;
    expect(getSignature(geminiPatched[0].tool_calls![0])).toBe(BYPASS_SIGNATURE);

    const otherPatched = patchMessages(
      [assistantWith([toolCall("call_unknown")])],
      makeCache(),
      matchNone,
      NOT_GEMINI,
    );
    expect(getSignature(otherPatched![0].tool_calls![0])).toBeUndefined();
  });

  it("promotes a top-level-only signature instead of clobbering it with the sentinel", () => {
    const cache = makeCache(); // miss
    const messages = [assistantWith([toolCall("call_a", { thought_signature: "clientSig" })])];
    const patched = patchMessages(messages, makeCache(), matchAll, GEMINI)!;
    expect(getSignature(patched[0].tool_calls![0])).toBe("clientSig");
    // Non-matching model: leave the fallback location untouched.
    const untouched = patchMessages(messages, cache, matchNone, NOT_GEMINI);
    expect(untouched).toBe(messages);
  });
});


describe("patchMessages — immutability", () => {
  it("returns the original array reference when nothing changed", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(patchMessages(messages, makeCache(), matchAll, GEMINI)).toBe(messages);
  });

  it("does not mutate frozen inputs", () => {
    const tc = Object.freeze(toolCall("call_a"));
    const message = Object.freeze(
      assistantWith(Object.freeze([tc]) as unknown as OpenAIToolCall[]),
    );
    const messages = Object.freeze([message]) as unknown as OpenAIMessage[];
    const patched = patchMessages(messages, makeCache({ call_a: "realSig" }), matchAll, GEMINI)!;
    expect(patched).not.toBe(messages);
    expect(getSignature(patched[0].tool_calls![0])).toBe("realSig");
    expect(message.tool_calls![0]).toBe(tc); // original untouched
  });
});

describe("patchRequestBody", () => {
  it("returns the original body reference on no-op", () => {
    const body = { model: GEMINI, messages: [{ role: "user", content: "hi" }], stream: true };
    expect(patchRequestBody(body, makeCache(), matchAll)).toBe(body);
  });

  it("returns non-object / message-less bodies unchanged", () => {
    const noMessages = { model: GEMINI };
    expect(patchRequestBody(noMessages, makeCache(), matchAll)).toBe(noMessages);
  });

  it("patches messages using body.model for gating", () => {
    const body = {
      model: GEMINI,
      messages: [assistantWith([toolCall("call_a")])],
      temperature: 0.7,
    };
    const patched = patchRequestBody(body, makeCache(), matchAll);
    expect(patched).not.toBe(body);
    expect(patched.temperature).toBe(0.7);
    expect(getSignature((patched.messages as OpenAIMessage[])[0].tool_calls![0])).toBe(
      BYPASS_SIGNATURE,
    );
  });
});
