import { afterEach, describe, expect, it, vi } from "vitest";
import { BYPASS_SIGNATURE } from "../../src/config.js";
import { startProxyAndMock, type ProxyTestRig } from "./helpers.js";
import { renderSse, respondJson, respondSse } from "./mockServer.js";

// Keep heartbeats out of the assertion window; S15 re-stubs briefly.
vi.stubEnv("SSE_HEARTBEAT_INTERVAL_MS", "60000");

const GEMINI = "gemini-3.8-flash";

/** OpenAI-format tool-call delta frame payload (JSON string for one frame). */
function toolDeltaFrame(toolCalls: unknown[], choiceIndex = 0): string {
  return JSON.stringify({ choices: [{ index: choiceIndex, delta: { tool_calls: toolCalls } }] });
}

const TEXT_FRAME = JSON.stringify({ choices: [{ index: 0, delta: { content: "thinking…" } }] });
// Fragmented like real Gemini streams: id and function name on the first
// delta, thought_signature on a LATER delta with no id (index correlates).
const ID_FIRST_DELTA = {
  index: 0,
  id: "call_A",
  type: "function",
  function: { name: "read_file", arguments: "" },
};
const SIG_LATER_DELTA = {
  index: 0,
  function: { arguments: "{}" },
  extra_content: { google: { thought_signature: "sig_123" } },
};
const UNSIGNED_T1 = {
  index: 1,
  id: "call_B",
  type: "function",
  function: { name: "write_file", arguments: "{}" },
};

// Realistic stream: keep-alive comment interleaved between deltas.
const PARALLEL_TURN1_FRAMES = [
  TEXT_FRAME,
  ": ping",
  toolDeltaFrame([ID_FIRST_DELTA]),
  toolDeltaFrame([SIG_LATER_DELTA]),
  toolDeltaFrame([UNSIGNED_T1]),
  "[DONE]",
];

function chatBody(messages: unknown[], model = GEMINI, stream = true): string {
  return JSON.stringify({ model, messages, stream });
}

/**
 * Streaming responses now open with the proxy's synthetic boot frame. Split it
 * off (it's the first \n\n-delimited frame), validate its shape, and return the
 * remaining bytes so byte-verbatim upstream assertions still hold. Heartbeat
 * comment frames are stripped from the remainder.
 */
function splitBootFrameAndRemainder(raw: string): {
  boot: Record<string, unknown>;
  remainder: string;
} {
  const boundary = raw.indexOf("\n\n");
  expect(boundary).toBeGreaterThanOrEqual(0);
  const first = raw.slice(0, boundary);
  expect(first.startsWith("data: ")).toBe(true);
  const boot = JSON.parse(first.slice("data: ".length)) as Record<string, unknown>;
  expect(boot.id).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
  expect(boot.object).toBe("chat.completion.chunk");
  expect(boot.model).toBe(GEMINI);
  const choices = boot.choices as Array<Record<string, unknown>>;
  expect(choices).toHaveLength(1);
  expect(choices[0].delta).toStrictEqual({ role: "assistant" });
  return {
    boot,
    remainder: raw.slice(boundary + 2).replace(/: heartbeat\n\n/g, ""),
  };
}

async function postChat(
  rig: ProxyTestRig,
  body: string,
  path = "/v1beta/openai/chat/completions",
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${rig.proxyUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
      "x-goog-api-key": "g-key",
      ...extraHeaders,
    },
    body,
  });
}

/** Assistant message echoing the (client-stripped) history from turn 1. */
function strippedHistory(): unknown[] {
  return [
    { role: "user", content: "read and write" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_A", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "call_B", type: "function", function: { name: "write_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_A", content: "file contents" },
    { role: "tool", tool_call_id: "call_B", content: "written" },
  ];
}

/** Assistant message with a never-seen tool call id. */
function unknownIdHistory(id = "call_X"): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: id, content: "ok" },
  ];
}

function lastRequestToolCalls(rig: ProxyTestRig, messageIndex: number, tcIndex: number) {
  const req = rig.mock.requests.at(-1)!.json as {
    messages: Array<{ tool_calls?: Array<Record<string, unknown>> }>;
  };
  return req.messages[messageIndex]!.tool_calls![tcIndex]! as Record<string, unknown> & {
    extra_content?: { google?: { thought_signature?: string } };
  };
}

let rig: ProxyTestRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe("S1: SSE parallel round-trip (the core fix)", () => {
  it("caches real signatures on turn 1 and re-injects them on turn 2", async () => {
    rig = await startProxyAndMock();

    // Turn 1: upstream streams parallel tool calls, CRLF, 7-byte slices.
    rig.mock.setChatResponder(respondSse({ frames: PARALLEL_TURN1_FRAMES, sliceBytes: 7 }));
    const res1 = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    const clientBytes = await res1.text();

    // Boot frame first, then byte-verbatim pass-through of upstream bytes.
    const { remainder } = splitBootFrameAndRemainder(clientBytes);
    expect(remainder).toBe(renderSse(PARALLEL_TURN1_FRAMES));

    // Cache learned: call_A signed, call_B a known unsigned sibling.
    expect(rig.cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
    expect(rig.cache.get("call_B")).toEqual({ state: "unsigned" });

    // Turn 2: client sends stripped history back (as Vercel AI SDK would).
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));
    const res2 = await postChat(rig, chatBody(strippedHistory(), GEMINI, false));
    expect(res2.status).toBe(200);
    await res2.text();

    const callA = lastRequestToolCalls(rig, 1, 0);
    const callB = lastRequestToolCalls(rig, 1, 1);

    // Real signature restored on the first call...
    expect(callA.extra_content?.google?.thought_signature).toBe("sig_123");
    // ...and the parallel sibling goes back EXACTLY as received — unsigned.
    expect("extra_content" in callB).toBe(false);
  });
});


describe("S2: sentinel fallback on true cache miss", () => {
  it("injects the bypass sentinel for never-seen ids on gemini models only", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));

    await (await postChat(rig, chatBody(unknownIdHistory(), GEMINI, false))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe(
      BYPASS_SIGNATURE,
    );

    // Non-gemini model: completely untouched.
    await (await postChat(rig, chatBody(unknownIdHistory(), "gpt-4o", false))).text();
    expect("extra_content" in lastRequestToolCalls(rig, 0, 0)).toBe(false);
  });

  it("never clobbers a client-supplied signature with the sentinel", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));

    const history = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_pres",
            type: "function",
            function: { name: "f", arguments: "{}" },
            extra_content: { google: { thought_signature: "clientSig" } },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_pres", content: "ok" },
    ];
    await (await postChat(rig, chatBody(history, GEMINI, false))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe(
      "clientSig",
    );
  });
});

describe("S3: non-stream JSON round-trip", () => {
  it("extracts from JSON response and forwards the exact upstream bytes", async () => {
    rig = await startProxyAndMock();
    const upstreamJson = JSON.stringify({
      id: "chatcmpl-1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [
              { id: "call_J1", extra_content: { google: { thought_signature: "jsonSig" } } },
              { id: "call_J2" },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
    rig.mock.setChatResponder(respondJson(upstreamJson));

    const res = await postChat(rig, JSON.stringify({ model: GEMINI, messages: [], stream: false }));
    expect(await res.text()).toBe(upstreamJson); // byte-exact forwarding

    expect(rig.cache.get("call_J1")).toEqual({ state: "signed", value: "jsonSig" });
    expect(rig.cache.get("call_J2")).toEqual({ state: "unsigned" });
  });
});

describe("S4: upstream error fidelity (non-stream)", () => {
  it("forwards 400 body/status unchanged and does not extract", async () => {
    rig = await startProxyAndMock();
    const errorBody = JSON.stringify({
      error: {
        code: 400,
        message: "Function call is missing a thought_signature",
        status: "INVALID_ARGUMENT",
      },
    });
    rig.mock.setChatResponder(respondJson(errorBody, 400));

    const res = await postChat(rig, chatBody([{ role: "user", content: "x" }], GEMINI, false));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(errorBody);
    expect(rig.cache.size).toBe(0);
  });

  it("forwards 429 with retry-after header preserved", async () => {
    rig = await startProxyAndMock();
    const errorBody = JSON.stringify({ error: { code: 429, message: "quota" } });
    rig.mock.setChatResponder(respondJson(errorBody, 429, { "retry-after": "30" }));

    const res = await postChat(rig, chatBody([{ role: "user", content: "x" }], GEMINI, false));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).toBe(errorBody);
  });
});

describe("S5: client aborts immediately after [DONE] (Vercel AI SDK pattern)", () => {
  it("still commits signatures and stays healthy", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(respondSse({ frames: PARALLEL_TURN1_FRAMES, delayMs: 5 }));

    const controller = new AbortController();
    const res = await fetch(`${rig.proxyUrl}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody([{ role: "user", content: "go" }]),
      signal: controller.signal,
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (received.includes("[DONE]")) {
          controller.abort();
          break;
        }
      }
    } catch (err) {
      // Aborted reads/closed sockets are the whole point of this test.
      expect((err as Error).name).toMatch(/AbortError|TypeError/);
    }

    // Committed at [DONE], before the client vanished.
    expect(rig.cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });

    // Proxy is not wedged: a follow-up request works normally.
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));
    const res2 = await postChat(rig, chatBody([{ role: "user", content: "again" }], GEMINI, false));
    expect(res2.status).toBe(200);
    await res2.text();
  });
});

describe("S6: upstream dies mid-turn (no [DONE])", () => {
  it("discards the partial turn; sentinel rescues the retry", async () => {
    rig = await startProxyAndMock();
    const partialFrames = [
      TEXT_FRAME,
      toolDeltaFrame([
        {
          index: 0,
          id: "call_partial",
          extra_content: { google: { thought_signature: "partialSig" } },
        },
      ]),
    ];
    const abortAt = renderSse(partialFrames).length - 5;
    rig.mock.setChatResponder(respondSse({ frames: partialFrames, abortAfterBytes: abortAt }));

    const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    await res.text().catch(() => undefined); // premature close — type varies by runtime

    // Discard rule: nothing from the aborted turn was cached.
    expect(rig.cache.get("call_partial")).toEqual({ state: "miss" });

    // Retry with the stripped history: sentinel fallback still saves the turn.
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));
    await (await postChat(rig, chatBody(unknownIdHistory("call_partial"), GEMINI, false))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe(
      BYPASS_SIGNATURE,
    );
  });
});


describe("S7: VS Code quirk path", () => {
  it("rewrites /v1beta/openai/v1/chat/completions and preserves query + flow", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(respondSse({ frames: PARALLEL_TURN1_FRAMES }));

    const res = await postChat(
      rig,
      chatBody([{ role: "user", content: "go" }]),
      "/v1beta/openai/v1/chat/completions?alt=sse",
    );
    expect(splitBootFrameAndRemainder(await res.text()).remainder).toBe(
      renderSse(PARALLEL_TURN1_FRAMES),
    );

    // Mock saw Google's real path, query intact.
    expect(rig.mock.requests[0]!.url).toBe("/v1beta/openai/chat/completions?alt=sse");
    expect(rig.cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
  });
});

describe("S7b: in-stream upstream error after a signed delta", () => {
  it("discards the partial turn when the stream ends on an error, not [DONE]", async () => {
    rig = await startProxyAndMock();
    // Real Gemini pattern: 200 + SSE opens fine, a tool call streams, then a
    // safety/quota error arrives as an in-stream payload and the stream ends.
    const errorFrames = [
      toolDeltaFrame([
        {
          index: 0,
          id: "call_err",
          extra_content: { google: { thought_signature: "errSig" } },
        },
      ]),
      JSON.stringify({ error: { code: 429, message: "resource exhausted" } }),
    ];
    rig.mock.setChatResponder(respondSse({ frames: errorFrames }));

    const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    expect(res.status).toBe(200);
    expect(splitBootFrameAndRemainder(await res.text()).remainder).toBe(renderSse(errorFrames));

    // No [DONE] => aborted turn => absolutely nothing committed.
    expect(rig.cache.get("call_err")).toEqual({ state: "miss" });
    expect(rig.cache.size).toBe(0);
  });
});

describe("S8: header hygiene across the hop", () => {
  it("forwards auth headers, recomputes content-length, forces identity encoding", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));

    // History triggers patching, so the body CHANGES size across the hop.
    // Client explicitly requests gzip — proxy must STILL force identity.
    await (
      await postChat(rig, chatBody(unknownIdHistory(), GEMINI, false), "/v1beta/openai/chat/completions", {
        "accept-encoding": "gzip, br",
      })
    ).text();

    const seen = rig.mock.requests[0]!;
    expect(seen.headers["authorization"]).toBe("Bearer test-key");
    expect(seen.headers["x-goog-api-key"]).toBe("g-key");
    expect(seen.headers["accept-encoding"]).toBe("identity");
    expect(seen.headers["host"]).not.toContain(new URL(rig.proxyUrl).host);
    // content-length must describe the PATCHED body the mock received.
    const contentLength = Number(seen.headers["content-length"]);
    expect(contentLength).toBe(seen.rawBody.length);
  });
});

describe("S10: PATCHED_MODELS csv mode end-to-end", () => {
  it("gates the sentinel but never gates real cached signatures", async () => {
    rig = await startProxyAndMock({ PATCHED_MODELS: GEMINI });
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));

    // Other gemini variant NOT in the list: miss -> NO sentinel.
    await (await postChat(rig, chatBody(unknownIdHistory(), "gemini-3.1-pro", false))).text();
    expect("extra_content" in lastRequestToolCalls(rig, 0, 0)).toBe(false);

    // Listed model: miss -> sentinel.
    await (await postChat(rig, chatBody(unknownIdHistory("call_Y"), GEMINI, false))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe(
      BYPASS_SIGNATURE,
    );

    // Seed a real signature, then use it on a NON-listed model: cache hit wins.
    rig.cache.set("call_seed", "realSig");
    const seededHistory = [
      {
        role: "assistant",
        tool_calls: [{ id: "call_seed", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_seed", content: "ok" },
    ];
    await (await postChat(rig, chatBody(seededHistory, "gemini-3.1-pro", false))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe("realSig");
  });
});


const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("S11: TTFT — boot frame arrives while upstream is still thinking", () => {
  it("delivers a first chunk in under 500ms with a 3s upstream header delay", async () => {
    rig = await startProxyAndMock();
    vi.stubEnv("SSE_HEARTBEAT_INTERVAL_MS", "500");
    rig.mock.setChatResponder(
      respondSse({ frames: PARALLEL_TURN1_FRAMES, headersDelayMs: 3000 }),
    );

    const t0 = Date.now();
    const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    const ttftMs = Date.now() - t0;

    // The whole point: Open Design's 2s first-chunk timer never fires.
    expect(ttftMs).toBeLessThan(500);
    expect(first.done).toBe(false);
    const firstText = decoder.decode(first.value, { stream: true });
    expect(firstText.startsWith("data: ")).toBe(true);

    let received = firstText;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }

    // Boot frame is first; the upstream bytes trail it byte-verbatim.
    const { remainder } = splitBootFrameAndRemainder(received);
    expect(remainder).toBe(renderSse(PARALLEL_TURN1_FRAMES));
    expect(received.indexOf(": heartbeat")).toBeGreaterThan(0);

    // Signature tap still learned from the stream.
    expect(rig.cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
    expect(rig.cache.get("call_B")).toEqual({ state: "unsigned" });
    vi.stubEnv("SSE_HEARTBEAT_INTERVAL_MS", "60000");
  }, 15000);
});

describe("S12: upstream error after the optimistic flush (stream)", () => {
  it("relays a 400 as an in-stream error frame after the boot frame, no [DONE]", async () => {
    rig = await startProxyAndMock();
    const errorBody = JSON.stringify({
      error: { code: 400, message: "missing thought_signature", status: "INVALID_ARGUMENT" },
    });
    rig.mock.setChatResponder(respondJson(errorBody, 400));

    const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    expect(res.status).toBe(200); // already flushed optimistically

    const body = await res.text();
    const { remainder } = splitBootFrameAndRemainder(body);
    expect(remainder).not.toContain("[DONE]");

    const frame = remainder.match(/^data: (.*)\n\n$/s);
    expect(frame).not.toBeNull();
    const payload = JSON.parse(frame![1]!) as { error: Record<string, unknown> };
    expect(payload.error.code).toBe(400);
    expect(payload.error.type).toBe("upstream_error");
    expect(payload.error.message).toBe("[Google 400] missing thought_signature");
  });

  it("includes retryAfter from the upstream retry-after header", async () => {
    rig = await startProxyAndMock();
    const errorBody = JSON.stringify({ error: { code: 429, message: "quota" } });
    rig.mock.setChatResponder(respondJson(errorBody, 429, { "retry-after": "30" }));

    const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    const body = await res.text();
    const { remainder } = splitBootFrameAndRemainder(body);
    const payload = JSON.parse(remainder.slice("data: ".length, -2)) as {
      error: Record<string, unknown>;
    };
    expect(payload.error.code).toBe(429);
    expect(payload.error.retryAfter).toBe("30");
  });
});

describe("S13: upstream answers 200 JSON to a streaming request (protocol anomaly)", () => {
  it("ends the stream with a 502 error frame instead of fabricating chunks", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));

    const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
    expect(res.status).toBe(200);
    const { remainder } = splitBootFrameAndRemainder(await res.text());
    expect(remainder).not.toContain("[DONE]");
    const payload = JSON.parse(remainder.slice("data: ".length, -2)) as {
      error: Record<string, unknown>;
    };
    expect(payload.error.code).toBe(502);
    expect(String(payload.error.message)).toContain("application/json");
  });
});

describe("S14: client disconnects while upstream is still thinking", () => {
  it("aborts the upstream fetch and stays healthy", async () => {
    rig = await startProxyAndMock();
    rig.mock.setChatResponder(
      respondSse({ frames: PARALLEL_TURN1_FRAMES, headersDelayMs: 1500 }),
    );

    const controller = new AbortController();
    const request = fetch(`${rig.proxyUrl}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody([{ role: "user", content: "go" }]),
      signal: controller.signal,
    }).catch(() => undefined);

    await sleep(300);
    controller.abort();
    await request;
    await sleep(1500); // let the delayed mock settle and notice the dead socket

    expect(rig.mock.requests.length).toBe(1);

    // Proxy survived: a normal follow-up works.
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));
    const res2 = await postChat(
      rig,
      chatBody([{ role: "user", content: "again" }], GEMINI, false),
    );
    expect(res2.status).toBe(200);
    await res2.text();
  }, 15000);
});

describe("S15: heartbeat frames keep the wire warm while awaiting upstream headers", () => {
  it("emits ': heartbeat' comments during the upstream header delay", async () => {
    vi.stubEnv("SSE_HEARTBEAT_INTERVAL_MS", "500");
    try {
      rig = await startProxyAndMock();
      rig.mock.setChatResponder(
        respondSse({ frames: PARALLEL_TURN1_FRAMES, headersDelayMs: 1200 }),
      );

      const res = await postChat(rig, chatBody([{ role: "user", content: "go" }]));
      const body = await res.text();
      expect(body).toContain(": heartbeat\n\n");
      expect(splitBootFrameAndRemainder(body).remainder).toBe(
        renderSse(PARALLEL_TURN1_FRAMES),
      );
    } finally {
      vi.stubEnv("SSE_HEARTBEAT_INTERVAL_MS", "60000");
    }
  }, 15000);
});
