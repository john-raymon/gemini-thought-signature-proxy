import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler } from "express";
import type { ProxyConfig } from "../types.js";
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  isAbortOrPrematureClose,
  resolvePassthroughUrl,
} from "./httpUtil.js";

/**
 * Decides what body (if any) the upstream fetch gets.
 *
 * - GET/HEAD/explicitly-empty: no body, no duplex.
 * - express.json() already consumed and parsed it: re-serialize (or pass
 *   Buffer/string through). Route-level scoping in Chunk 5 keeps this rare.
 * - Otherwise: stream req straight through with duplex: 'half' — Undici
 *   throws without that flag, and auto-resumes the paused Express stream.
 */
function resolveUpstreamBody(req: Request): {
  body?: string | Buffer | Readable;
  duplex?: "half";
} {
  if (req.method === "GET" || req.method === "HEAD" || req.headers["content-length"] === "0") {
    return {};
  }

  const parsed = req.body as unknown;
  if (parsed !== undefined && parsed !== null) {
    if (Buffer.isBuffer(parsed)) return { body: parsed };
    if (typeof parsed === "string") return { body: parsed };
    if (typeof parsed === "object") {
      // ANY parsed object — even {} — means a body parser already consumed
      // the req stream. Falling through to { body: req } would make Undici
      // read an EOF'd stream and blow up with a length mismatch.
      return { body: JSON.stringify(parsed) };
    }
  }

  return { body: req, duplex: "half" };
}

/**
 * Catch-all passthrough for non-chat endpoints (model listing, token
 * counting, etc.). No signature logic: forwards method, path, query, and
 * body to upstream and streams the response back, with the same header
 * hygiene and abort wiring as the chat route.
 */
export function createPassthroughHandler(config: ProxyConfig): RequestHandler {
  return async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      const url = resolvePassthroughUrl(config.upstreamBaseUrl, req.originalUrl);
      const headers = buildUpstreamHeaders(req.headers);
      const { body, duplex } = resolveUpstreamBody(req);

      console.log(`[pass] → ${req.method} ${url}`);

      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        // Node fetch requires duplex:'half' whenever body is a stream.
        duplex,
        signal: ac.signal,
      });

      res.status(upstream.status);
      copyResponseHeaders(upstream.headers, res, false);

      if (upstream.body) {
        try {
          await pipeline(
            Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream),
            res,
          );
        } catch (err) {
          if (!isAbortOrPrematureClose(err)) {
            console.error("[pass] stream error after headers sent:", err);
          }
        }
      } else {
        res.end();
      }
    } catch (err) {
      if (ac.signal.aborted || res.destroyed) return;
      if (!isAbortOrPrematureClose(err)) {
        console.error("[pass] ✖ upstream error:", err);
      }
      if (!res.headersSent) {
        res.status(502).json({ error: "proxy_error" });
      } else {
        res.destroy();
      }
    }
  };
}
