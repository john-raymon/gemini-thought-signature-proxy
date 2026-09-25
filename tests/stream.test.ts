import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { SignatureCache } from "../src/cache.js";
import { SseSignatureExtractor } from "../src/extract.js";
import { SignatureTap } from "../src/stream.js";

function makeCache() {
  return new SignatureCache({ maxEntries: 100, ttlMs: 60_000, sweepIntervalMs: null });
}

function makeTap(cache: SignatureCache) {
  return new SignatureTap(new SseSignatureExtractor(cache));
}

async function collect(source: Readable, tap: SignatureTap): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new (await import("node:stream")).Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  await pipeline(source, tap, sink);
  return Buffer.concat(chunks);
}

describe("SignatureTap byte fidelity", () => {
  it("forwards arbitrary binary chunks verbatim", async () => {
    const cache = makeCache();
    const tap = makeTap(cache);
    const input = [Buffer.from([0, 1, 2, 255, 254]), Buffer.from("hello \n\n"), Buffer.alloc(1024, 7)];
    const out = await collect(Readable.from(input), tap);
    expect(out.equals(Buffer.concat(input))).toBe(true);
  });

  it("does not corrupt multi-byte UTF-8 split across chunks", async () => {
    const cache = makeCache();
    const tap = makeTap(cache);
    const text = "data: thought 🧠 bubble\n\n";
    const bytes = Buffer.from(text, "utf8");
    // Split inside the 4-byte emoji sequence.
    const emojiStart = bytes.indexOf(0xf0);
    const first = bytes.subarray(0, emojiStart + 2);
    const second = bytes.subarray(emojiStart + 2);
    const out = await collect(Readable.from([first, second]), tap);
    expect(out.equals(bytes)).toBe(true);
    expect(out.toString("utf8")).toBe(text);
    expect(out.toString("utf8")).not.toContain("�");
  });
});

describe("SignatureTap extraction", () => {
  const FIRST_DELTA = `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_A",
              extra_content: { google: { thought_signature: "sig_123" } },
            },
          ],
        },
      },
    ],
  })}\n\n`;
  const SIBLING = `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_B" }] } }],
  })}\n\n`;

  it("extracts signatures while streaming bytes through", async () => {
    const cache = makeCache();
    const tap = makeTap(cache);
    const streamText = FIRST_DELTA + SIBLING + "data: [DONE]\n\n";
    const out = await collect(Readable.from([Buffer.from(streamText)]), tap);
    expect(out.toString("utf8")).toBe(streamText);
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
    expect(cache.get("call_B")).toEqual({ state: "unsigned" });
  });

  it("handles extraction across many small chunks", async () => {
    const cache = makeCache();
    const tap = makeTap(cache);
    const streamText = FIRST_DELTA + "data: [DONE]\r\n\r\n";
    const bytes = Buffer.from(streamText, "utf8");
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.subarray(i, i + 5));
    await collect(Readable.from(chunks), tap);
    expect(cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });

  it("discards accumulators when the stream ends without [DONE]", async () => {
    const cache = makeCache();
    const tap = makeTap(cache);
    await collect(Readable.from([Buffer.from(FIRST_DELTA)]), tap);
    expect(cache.size).toBe(0);
  });

  it("propagates source errors through the pipeline", async () => {
    const cache = makeCache();
    const tap = makeTap(cache);
    const source = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("source boom"));
      },
    });
    const sink = new (await import("node:stream")).Writable({ write(_c, _e, cb) { cb(); } });
    await expect(pipeline(source, tap, sink)).rejects.toThrow("source boom");
  });
});
