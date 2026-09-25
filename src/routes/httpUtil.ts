import type { IncomingHttpHeaders } from "node:http";
import type { Response } from "express";

/**
 * Headers that must never cross a proxy hop. Forwarding `host` causes SNI
 * mismatches at Google's frontends; `content-length` is recomputed by fetch
 * after body patching; `accept-encoding` is forced to identity ourselves so
 * the SSE parser never sees compressed bytes.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/**
 * Filters client headers for the upstream request: drops hop-by-hop entries
 * (authorization, x-goog-api-*, and custom headers survive), joins array
 * values, and forces identity encoding.
 */
export function buildUpstreamHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function splitPathAndQuery(originalUrl: string): { pathname: string; search: string } {
  const qIndex = originalUrl.indexOf("?");
  let pathname = qIndex === -1 ? originalUrl : originalUrl.slice(0, qIndex);
  const search = qIndex === -1 ? "" : originalUrl.slice(qIndex);
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return { pathname, search };
}

const VSCODE_QUIRK_PATH = "/v1beta/openai/v1/chat/completions";
const GOOGLE_CHAT_PATH = "/v1beta/openai/chat/completions";
const OPENAI_BETA_PREFIX = "/v1beta/openai";

/**
 * Resolves the upstream chat-completions URL. VS Code appends
 * "v1/chat/completions" to a base ending in /v1beta/openai, producing a
 * nonexistent /v1beta/openai/v1/chat/completions path — rewrite it to
 * Google's real path. Query strings (?key=..., ?alt=sse) always survive.
 * Plain string concat, not new URL(): resolving an absolute path against a
 * base URL wipes the base's pathname.
 */
export function resolveChatCompletionsUrl(base: string, originalUrl: string): string {
  let { pathname } = splitPathAndQuery(originalUrl);
  const { search } = splitPathAndQuery(originalUrl);
  const cleanBase = stripTrailingSlashes(base);

  if (pathname === VSCODE_QUIRK_PATH) pathname = GOOGLE_CHAT_PATH;

  // A base that itself ends in /v1beta/openai must not get the prefix twice.
  if (cleanBase.endsWith(OPENAI_BETA_PREFIX) && pathname.startsWith(OPENAI_BETA_PREFIX)) {
    pathname = pathname.slice(OPENAI_BETA_PREFIX.length);
  }

  const full = `${cleanBase}${pathname}`.replace(VSCODE_QUIRK_PATH, GOOGLE_CHAT_PATH);
  return `${full}${search}`;
}

/** Resolves a passthrough URL preserving path and query verbatim. */
export function resolvePassthroughUrl(base: string, originalUrl: string): string {
  const { pathname, search } = splitPathAndQuery(originalUrl);
  const cleanBase = stripTrailingSlashes(base);
  // Same prefix-dedup rule for bases already pointing at /v1beta/openai.
  const path =
    cleanBase.endsWith(OPENAI_BETA_PREFIX) && pathname.startsWith(OPENAI_BETA_PREFIX)
      ? pathname.slice(OPENAI_BETA_PREFIX.length)
      : pathname;
  return `${cleanBase}${path}${search}`;
}

const RESPONSE_SKIP_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * Copies upstream response headers onto the Express response, dropping
 * framing headers Express/Node manage itself. SSE responses additionally
 * get anti-buffering hints so intermediaries don't batch the stream.
 */
export function copyResponseHeaders(
  upstream: Headers,
  res: Response,
  isSse: boolean,
): void {
  upstream.forEach((value, name) => {
    if (RESPONSE_SKIP_HEADERS.has(name.toLowerCase())) return;
    res.setHeader(name, value);
  });
  if (isSse) {
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
  }
}

/**
 * Client disconnects mid-stream are routine (right after [DONE], user
 * presses Escape). These errors must be swallowed, not logged as failures.
 * Undici wraps aborts in "TypeError: fetch failed" with the real reason on
 * err.cause — recurse into it.
 */
export function isAbortOrPrematureClose(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  if (
    e.name === "AbortError" ||
    e.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    e.code === "ERR_STREAM_DESTROYED" ||
    e.code === "ECONNRESET" ||
    e.code === "UND_ERR_ABORTED" ||
    (typeof e.message === "string" && e.message.toLowerCase().includes("aborted"))
  ) {
    return true;
  }
  return e.cause !== undefined && isAbortOrPrematureClose(e.cause);
}
