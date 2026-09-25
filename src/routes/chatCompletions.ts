import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RequestHandler } from "express";
import type { SignatureCache } from "../cache.js";
import { SseSignatureExtractor, extractFromJsonResponse } from "../extract.js";
import { patchRequestBody } from "../inject.js";
import { SignatureTap } from "../stream.js";
import type { ProxyConfig } from "../types.js";
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  isAbortOrPrematureClose,
  resolveChatCompletionsUrl,
} from "./httpUtil.js";

/**
 * Chat-completions interception. Mounted (in Chunk 5) on BOTH:
 *   POST /v1beta/openai/chat/completions      (Open Design: base + /chat/completions)
 *   POST /v1beta/openai/v1/chat/completions   (VS Code: base + v1/chat/completions)
 *
 * Flow: patch outbound messages with cached signatures (or the sentinel on
 * cache miss for gemini-matching models) -> forward upstream -> extract
 * signatures from the response (SSE tap or one-shot JSON) -> forward the
 * response bytes verbatim (never re-serialized).
 */
export function createChatCompletionsHandler(
  cache: SignatureCache,
  config: ProxyConfig,
): RequestHandler {
  return async (req, res) => {
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      const patchedBody = patchRequestBody(req.body, cache, config.shouldPatchModel);
      const patched = patchedBody !== req.body;
      const url = resolveChatCompletionsUrl(config.upstreamBaseUrl, req.originalUrl);
      const headers = buildUpstreamHeaders(req.headers);
      headers["content-type"] = "application/json";

      console.log(
        `[chat] → ${url} model=${(req.body as { model?: unknown } | undefined)?.model} patched=${patched}`,
      );

      const upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(patchedBody),
        signal: ac.signal,
      });

      res.status(upstream.status);
      const contentType = upstream.headers.get("content-type") ?? "";
      const isSse = contentType.includes("text/event-stream");
      copyResponseHeaders(upstream.headers, res, isSse);

      if (isSse && upstream.body) {
        res.flushHeaders();
        const tap = new SignatureTap(new SseSignatureExtractor(cache));
        try {
          await pipeline(
            Readable.fromWeb(upstream.body as unknown as import("node:stream/web").ReadableStream),
            tap,
            res,
          );
        } catch (err) {
          if (!isAbortOrPrematureClose(err)) {
            console.error("[chat] stream error after headers sent:", err);
          }
        }
        return;
      }

      const raw = Buffer.from(await upstream.arrayBuffer());

      // Extract only from successful JSON responses; error bodies (400/429)
      // are forwarded untouched and never parsed.
      if (upstream.ok && contentType.includes("json")) {
        try {
          const stats = extractFromJsonResponse(
            JSON.parse(raw.toString("utf8")),
            cache,
          );
          if (stats.signed + stats.unsigned > 0) {
            console.log(`[chat] extracted signed=${stats.signed} unsigned=${stats.unsigned}`);
          }
        } catch {
          // Body wasn't parseable JSON; forward it verbatim anyway.
        }
      }

      res.send(raw);
    } catch (err) {
      // Routine disconnect: client left mid-flight, nothing to report.
      if (ac.signal.aborted || res.destroyed) return;
      if (!isAbortOrPrematureClose(err)) {
        console.error("[chat] ✖ upstream error:", err);
      }
      if (!res.headersSent) {
        res.status(502).json({ error: "proxy_error" });
      } else {
        res.destroy();
      }
    }
  };
}
