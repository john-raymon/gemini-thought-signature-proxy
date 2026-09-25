import { afterEach, describe, expect, it } from "vitest";
import { BYPASS_SIGNATURE } from "../../src/config.js";
import { startProxyAndMock, type ProxyTestRig } from "./helpers.js";
import { renderSse, respondJson, respondSse } from "./mockServer.js";

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

function chatBody(messages: unknown[], model = GEMINI): string {
  return JSON.stringify({ model, messages, stream: true });
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

    // Byte-verbatim pass-through: client body == upstream payload exactly.
    expect(clientBytes).toBe(renderSse(PARALLEL_TURN1_FRAMES));

    // Cache learned: call_A signed, call_B a known unsigned sibling.
    expect(rig.cache.get("call_A")).toEqual({ state: "signed", value: "sig_123" });
    expect(rig.cache.get("call_B")).toEqual({ state: "unsigned" });

    // Turn 2: client sends stripped history back (as Vercel AI SDK would).
    rig.mock.setChatResponder(respondJson(JSON.stringify({ choices: [] })));
    const res2 = await postChat(rig, chatBody(strippedHistory()));
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

    await (await postChat(rig, chatBody(unknownIdHistory(), GEMINI))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe(
      BYPASS_SIGNATURE,
    );

    // Non-gemini model: completely untouched.
    await (await postChat(rig, chatBody(unknownIdHistory(), "gpt-4o"))).text();
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
    await (await postChat(rig, chatBody(history, GEMINI))).text();
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

describe("S4: upstream error fidelity", () => {
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

    const res = await postChat(rig, chatBody([{ role: "user", content: "x" }]));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(errorBody);
    expect(rig.cache.size).toBe(0);
  });

  it("forwards 429 with retry-after header preserved", async () => {
    rig = await startProxyAndMock();
    const errorBody = JSON.stringify({ error: { code: 429, message: "quota" } });
    rig.mock.setChatResponder(respondJson(errorBody, 429, { "retry-after": "30" }));

    const res = await postChat(rig, chatBody([{ role: "user", content: "x" }]));
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
    const res2 = await postChat(rig, chatBody([{ role: "user", content: "again" }]));
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
    await (await postChat(rig, chatBody(unknownIdHistory("call_partial")))).text();
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
    expect(await res.text()).toBe(renderSse(PARALLEL_TURN1_FRAMES));

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
    expect(await res.text()).toBe(renderSse(errorFrames));

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
      await postChat(rig, chatBody(unknownIdHistory()), "/v1beta/openai/chat/completions", {
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
    await (await postChat(rig, chatBody(unknownIdHistory(), "gemini-3.1-pro"))).text();
    expect("extra_content" in lastRequestToolCalls(rig, 0, 0)).toBe(false);

    // Listed model: miss -> sentinel.
    await (await postChat(rig, chatBody(unknownIdHistory("call_Y"), GEMINI))).text();
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
    await (await postChat(rig, chatBody(seededHistory, "gemini-3.1-pro"))).text();
    expect(lastRequestToolCalls(rig, 0, 0).extra_content?.google?.thought_signature).toBe("realSig");
  });
});

