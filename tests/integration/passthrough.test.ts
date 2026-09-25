import { afterEach, describe, expect, it } from "vitest";
import { startProxyAndMock, type ProxyTestRig } from "./helpers.js";

let rig: ProxyTestRig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe("S9: passthrough fidelity", () => {
  it("GET with query params arrives verbatim and echoes back", async () => {
    rig = await startProxyAndMock();

    const res = await fetch(`${rig.proxyUrl}/v1beta/models?pageSize=5&pageToken=abc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo: boolean; method: string; url: string };
    expect(body.echo).toBe(true);
    expect(body.method).toBe("GET");
    expect(body.url).toBe("/v1beta/models?pageSize=5&pageToken=abc");

    const seen = rig.mock.requests[0]!;
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/v1beta/models?pageSize=5&pageToken=abc");
    expect(seen.rawBody.length).toBe(0);
  });

  it("POST body crosses the hop byte-for-byte (echo reflects it)", async () => {
    rig = await startProxyAndMock();
    const payload = JSON.stringify({ content: { parts: [{ text: "embed me 🔍" }] } });

    const res = await fetch(`${rig.proxyUrl}/v1beta/models/gemini:embedContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string; contentType: string };

    // Mock received identical bytes (UTF-8 emoji intact, length matches).
    const seen = rig.mock.requests[0]!;
    expect(seen.text).toBe(payload);
    // Streamed passthrough delivers chunked (nothing to recompute — the
    // body is NOT rewritten on this route); if content-length IS present it
    // must match what actually arrived.
    const contentLength = seen.headers["content-length"];
    if (contentLength !== undefined) {
      expect(Number(contentLength)).toBe(seen.rawBody.length);
    } else {
      expect(seen.headers["transfer-encoding"]).toBe("chunked");
    }
    expect(body.body).toBe(payload);
    expect(body.contentType).toContain("application/json");
  });

  it("non-chat GET on the chat-completions path goes through passthrough, not the chat handler", async () => {
    rig = await startProxyAndMock();
    const res = await fetch(`${rig.proxyUrl}/v1beta/openai/chat/completions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo: boolean };
    expect(body.echo).toBe(true); // echo responder = passthrough route
    expect(rig.cache.size).toBe(0);
  });

  it("204 No Content upstream completes without hanging", async () => {
    rig = await startProxyAndMock();
    const res = await fetch(`${rig.proxyUrl}/no-content`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
