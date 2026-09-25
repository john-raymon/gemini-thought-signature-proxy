import { describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  isAbortOrPrematureClose,
  resolveChatCompletionsUrl,
  resolvePassthroughUrl,
} from "../src/routes/httpUtil.js";

const BASE = "https://generativelanguage.googleapis.com";

describe("buildUpstreamHeaders", () => {
  it("strips hop-by-hop headers including host and content-length", () => {
    const headers = buildUpstreamHeaders({
      host: "localhost:3000",
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "content-length": "1234",
      "accept-encoding": "gzip, br",
      upgrade: "websocket",
      te: "trailers",
      trailer: "x",
      authorization: "Bearer KEY",
      "x-goog-api-key": "GOOG",
      "content-type": "application/json",
    });
    expect(headers).toEqual({
      authorization: "Bearer KEY",
      "x-goog-api-key": "GOOG",
      "content-type": "application/json",
      "accept-encoding": "identity",
    });
  });

  it("forces identity encoding even when client omitted accept-encoding", () => {
    const headers = buildUpstreamHeaders({});
    expect(headers["accept-encoding"]).toBe("identity");
  });

  it("joins multi-value headers and skips undefined", () => {
    const headers = buildUpstreamHeaders({
      "x-multi": ["a", "b"],
      "x-undefined": undefined,
    });
    expect(headers["x-multi"]).toBe("a, b");
    expect("x-undefined" in headers).toBe(false);
  });
});

describe("resolveChatCompletionsUrl", () => {
  it("passes the Open Design path through with query preserved", () => {
    expect(
      resolveChatCompletionsUrl(BASE, "/v1beta/openai/chat/completions?alt=sse&key=K"),
    ).toBe(`${BASE}/v1beta/openai/chat/completions?alt=sse&key=K`);
  });

  it("rewrites the VS Code /v1/ quirk path", () => {
    expect(resolveChatCompletionsUrl(BASE, "/v1beta/openai/v1/chat/completions")).toBe(
      `${BASE}/v1beta/openai/chat/completions`,
    );
  });

  it("rewrites the quirk path while keeping query params", () => {
    expect(
      resolveChatCompletionsUrl(BASE, "/v1beta/openai/v1/chat/completions?key=XYZ"),
    ).toBe(`${BASE}/v1beta/openai/chat/completions?key=XYZ`);
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(resolveChatCompletionsUrl(`${BASE}/`, "/v1beta/openai/chat/completions")).toBe(
      `${BASE}/v1beta/openai/chat/completions`,
    );
  });

  it("handles a base that itself ends in /v1beta/openai with /v1/chat/completions appended", () => {
    expect(
      resolveChatCompletionsUrl(`${BASE}/v1beta/openai`, "/v1/chat/completions"),
    ).toBe(`${BASE}/v1beta/openai/chat/completions`);
  });

  it("does not duplicate /v1beta/openai when base and path both carry the prefix", () => {
    expect(
      resolveChatCompletionsUrl(`${BASE}/v1beta/openai`, "/v1beta/openai/chat/completions?key=K"),
    ).toBe(`${BASE}/v1beta/openai/chat/completions?key=K`);
    expect(
      resolveChatCompletionsUrl(`${BASE}/v1beta/openai`, "/v1beta/openai/v1/chat/completions"),
    ).toBe(`${BASE}/v1beta/openai/chat/completions`);
  });
});

describe("resolvePassthroughUrl", () => {
  it("preserves arbitrary paths and query strings verbatim", () => {
    expect(resolvePassthroughUrl(BASE, "/v1beta/models?pageSize=10&pageToken=abc")).toBe(
      `${BASE}/v1beta/models?pageSize=10&pageToken=abc`,
    );
  });

  it("normalizes missing leading slash and base trailing slash", () => {
    expect(resolvePassthroughUrl(`${BASE}///`, "v1beta/models")).toBe(`${BASE}/v1beta/models`);
  });

  it("does not duplicate /v1beta/openai when the base already carries the prefix", () => {
    expect(
      resolvePassthroughUrl(`${BASE}/v1beta/openai`, "/v1beta/openai/models?pageSize=5"),
    ).toBe(`${BASE}/v1beta/openai/models?pageSize=5`);
  });
});

describe("copyResponseHeaders", () => {
  function fakeRes() {
    const headers = new Map<string, string>();
    return {
      headers,
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
    } as never;
  }

  it("drops framing headers and keeps the rest", () => {
    const upstream = new Headers({
      "content-type": "application/json",
      "content-length": "100",
      "content-encoding": "gzip",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-request-id": "r1",
    });
    const res = fakeRes() as { headers: Map<string, string> };
    copyResponseHeaders(upstream, res as never, false);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-request-id")).toBe("r1");
    expect(res.headers.has("content-length")).toBe(false);
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(res.headers.has("connection")).toBe(false);
  });

  it("adds anti-buffering hints for SSE responses", () => {
    const upstream = new Headers({ "content-type": "text/event-stream" });
    const res = fakeRes() as { headers: Map<string, string> };
    copyResponseHeaders(upstream, res as never, true);
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });
});

describe("isAbortOrPrematureClose", () => {
  it("recognizes routine disconnect errors", () => {
    expect(isAbortOrPrematureClose(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(
      isAbortOrPrematureClose(Object.assign(new Error("x"), { code: "ERR_STREAM_PREMATURE_CLOSE" })),
    ).toBe(true);
    expect(isAbortOrPrematureClose(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isAbortOrPrematureClose(new Error("The operation was aborted"))).toBe(true);
  });

  it("rejects real errors and junk", () => {
    expect(isAbortOrPrematureClose(new Error("socket hang up"))).toBe(false);
    expect(isAbortOrPrematureClose(null)).toBe(false);
    expect(isAbortOrPrematureClose("abort")).toBe(false);
  });

  it("recognizes Undici abort codes directly and via err.cause", () => {
    expect(
      isAbortOrPrematureClose(Object.assign(new Error("terminated"), { code: "UND_ERR_ABORTED" })),
    ).toBe(true);
    // Node fetch aborts surface as "TypeError: fetch failed" wrapping an AbortError.
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    });
    expect(isAbortOrPrematureClose(wrapped)).toBe(true);
    const deepWrapped = Object.assign(new TypeError("fetch failed"), { cause: wrapped });
    expect(isAbortOrPrematureClose(deepWrapped)).toBe(true);
    // Unrelated cause chain stays false.
    const unrelated = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("certificate expired"),
    });
    expect(isAbortOrPrematureClose(unrelated)).toBe(false);
  });
});
