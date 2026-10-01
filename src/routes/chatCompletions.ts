import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RequestHandler } from "express";
import type { SignatureCache } from "../cache.js";
import { SseSignatureExtractor, extractFromJsonResponse } from "../extract.js";
import { patchRequestBody } from "../inject.js";
import {
  HEARTBEAT_FRAME,
  getHeartbeatIntervalMs,
  makeBootFrame,
  makeSseErrorFrame,
} from "../ssePrelude.js";
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
 *
 * Streaming requests (stream:true) get an optimistic prelude upstream of the
 * fetch call: headers are flushed immediately with a synthetic boot frame so a
 * client's first-chunk timer resets long before Google sends response bytes
 * (the thinking phase can take 6-10s). Trade-off: for streamed requests only,
 * upstream errors are relayed as in-stream SSE error frames instead of HTTP
 * statuses, since the 200 was already flushed. Non-streaming requests keep
 * verbatim status/body forwarding.
 */
export function createChatCompletionsHandler(
  cache: SignatureCache,
  config: ProxyConfig,
): RequestHandler {
  return async (req, res) => {
    const ac = new AbortController();
    let heartbeat: NodeJS.Timeout | undefined;
    const clearHeartbeat = (): void => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    res.on("close", () => {
      clearHeartbeat();
      if (!res.writableEnded) ac.abort();
    });
    res.on("error", (err) => {
      if (!isAbortOrPrematureClose(err)) {
        console.error("[chat] response error:", err);
      }
    });

    /** Write only while the socket is still open; never throw on a dead peer. */
    const safeWrite = (chunk: string): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(chunk);
      } catch {
        // Peer vanished between the guard and the write — nothing to do.
      }
    };
    const safeEnd = (): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.end();
      } catch {
        // Peer vanished; close listener handles cleanup.
      }
    };

    const body = req.body as
      | { stream?: unknown; messages?: unknown; model?: unknown }
      | undefined;
    const isStreamRequest = body?.stream === true && Array.isArray(body.messages);

    try {
      const startedAt = Date.now();
      const patchedBody = patchRequestBody(req.body, cache, config.shouldPatchModel);
      const patched = patchedBody !== req.body;
      const url = resolveChatCompletionsUrl(config.upstreamBaseUrl, req.originalUrl);
      const headers = buildUpstreamHeaders(req.headers);
      headers["content-type"] = "application/json";

      const serialized = JSON.stringify(patchedBody);
      console.log(
        `[chat] ${new Date().toISOString()} → ${url} model=${(req.body as { model?: unknown } | undefined)?.model} stream=${isStreamRequest} patched=${patched} bodyBytes=${serialized.length}`,
      );

      if (isStreamRequest) {
        // Optimistic prelude: claim the SSE response and reset the client's
        // first-chunk timer BEFORE fetch even hears back from Google. The boot
        // frame is written straight to res, downstream of the SignatureTap
        // (which only wraps upstream.body), so signature extraction and byte
        // accounting are unaffected by construction.
        res.status(200);
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache, no-transform");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders();
        safeWrite(makeBootFrame(body?.model));
        heartbeat = setInterval(() => safeWrite(HEARTBEAT_FRAME), getHeartbeatIntervalMs());
        heartbeat.unref();
      }

      const upstream = await fetch(url, {
        method: "POST",
        headers,
        body: serialized,
        signal: ac.signal,
      });

      // Upstream headers have arrived — no more heartbeats from here on
      // (they'd interleave with the real chunks).
      clearHeartbeat();
      console.log(
        `[chat] ← ${upstream.status} settled in ${Date.now() - startedAt}ms`,
      );
      if (isStreamRequest) {
        const contentType = upstream.headers.get("content-type") ?? "";
        const isSse = contentType.includes("text/event-stream");
        const upstreamBody = upstream.body;

        if (upstream.ok && isSse && upstreamBody) {
          const tap = new SignatureTap(new SseSignatureExtractor(cache));
          try {
            await pipeline(
              Readable.fromWeb(
                upstreamBody as unknown as import("node:stream/web").ReadableStream,
              ),
              tap,
              res,
            );
          } catch (err) {
            // Mid-stream failures: headers + earlier chunks are already with
            // the client; never append an error frame — just close.
            if (!isAbortOrPrematureClose(err)) {
              console.error("[chat] stream error after headers sent:", err);
            }
          }
          return;
        }

        if (!upstream.ok) {
          // Headers were flushed optimistically, so the real status can't ride
          // the HTTP line anymore: relay it as an in-stream error frame.
          const bodyText = await upstream.text();
          safeWrite(
            makeSseErrorFrame({
              status: upstream.status,
              bodyText,
              retryAfter: upstream.headers.get("retry-after"),
            }),
          );
          safeEnd();
          return;
        }

        // Protocol anomaly: stream requested but upstream answered non-SSE 200.
        await upstream.text(); // drain so the upstream socket is released
        safeWrite(
          makeSseErrorFrame({
            status: 502,
            bodyText: `Upstream returned ${contentType || "no content-type"} for a streaming request; expected text/event-stream`,
          }),
        );
        safeEnd();
        return;
      }

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
      clearHeartbeat();
      // Routine disconnect: client left mid-flight, nothing to report.
      if (ac.signal.aborted || res.destroyed) return;
      if (!isAbortOrPrematureClose(err)) {
        console.error("[chat] ✖ upstream error:", err);
      }
      if (isStreamRequest && res.headersSent) {
        // Fetch failed after the optimistic prelude: end with an error frame.
        safeWrite(
          makeSseErrorFrame({ status: 502, bodyText: "Proxy failed to reach upstream" }),
        );
        safeEnd();
      } else if (!res.headersSent) {
        res.status(502).json({ error: "proxy_error" });
      } else {
        res.destroy();
      }
    }
  };
}
