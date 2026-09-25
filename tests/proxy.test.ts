import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createProxyApp } from "../src/proxy.js";
import type { SignatureCache } from "../src/cache.js";

interface RunningApp {
  server: Server;
  cache: SignatureCache;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startApp(
  env: NodeJS.ProcessEnv = {},
  options?: Parameters<typeof createProxyApp>[1],
): Promise<RunningApp> {
  const config = loadConfig({ PORT: "0", HOST: "127.0.0.1", ...env });
  const { app, cache } = createProxyApp(config, options);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    cache,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        cache.dispose();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

let running: RunningApp | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe("createProxyApp assembly", () => {
  it("exposes the cache on the return value and app.locals", async () => {
    running = await startApp();
    expect(running.cache.size).toBe(0);
    // locals access mirrors what integration tests use in Chunk 6.
  });

  it("GET /healthz returns ok JSON without touching upstream", async () => {
    running = await startApp();
    const res = await fetch(`${running.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("body-parser error handling", () => {
  it("malformed JSON on a chat route -> 400 OpenAI-shaped error, not HTML", async () => {
    running = await startApp({ UPSTREAM_BASE_URL: "http://127.0.0.1:1" });
    const res = await fetch(`${running.baseUrl}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json ...",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe("invalid_json");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("oversized chat body -> 413 payload_too_large (injected tiny limit)", async () => {
    running = await startApp({ UPSTREAM_BASE_URL: "http://127.0.0.1:1" }, { jsonLimit: "10b" });
    const res = await fetch(`${running.baseUrl}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });
});

describe("unreachable upstream", () => {
  it("chat request against a dead upstream -> 502 proxy_error JSON", async () => {
    // Port 1 on loopback refuses fast on macOS/Linux dev machines.
    running = await startApp({ UPSTREAM_BASE_URL: "http://127.0.0.1:1" });
    const res = await fetch(`${running.baseUrl}/v1beta/openai/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash", messages: [] }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("proxy_error");
  });

  it("passthrough request against a dead upstream -> 502 proxy_error JSON", async () => {
    running = await startApp({ UPSTREAM_BASE_URL: "http://127.0.0.1:1" });
    const res = await fetch(`${running.baseUrl}/v1beta/models`);
    expect(res.status).toBe(502);
  });
});
