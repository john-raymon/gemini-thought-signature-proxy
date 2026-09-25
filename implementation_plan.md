# Implementation Plan — TTFT SSE Latency Fix (v2.1.0)

**Status: In progress** — supersedes the completed v2.0.0 plan (preserved in git history at `9c3217f`).

## Overview

Fix a time-to-first-token (TTFT) failure: Open Design's Vercel AI SDK client hardcodes a 2s first-chunk timer; Gemini 3.8 Flash's long thinking phase can delay its first response byte 6–10s, so the client severs and aggressively retries, burning tokens. The fix makes the proxy optimistic for `stream: true` requests: flush SSE headers + a synthetic boot data frame immediately, emit heartbeat comments while awaiting upstream, then stream Google through byte-verbatim exactly as today (`thought_signature` extraction untouched).

Context from investigation: the current SSE branch (`src/routes/chatCompletions.ts:59–67`) already forwards chunks with zero added latency (`pipeline(Readable.fromWeb, SignatureTap, res)` + `flushHeaders` after upstream headers) — the gap is everything BEFORE Google's first byte. Headers alone and SSE comment lines alone both fail to trip the SDK parser's first-chunk timer; only a real `data:` frame does. Therefore the plan sends a real data frame (role delta) immediately.

Trade-off (user-approved): optimistic 200 flush happens before knowing upstream status; upstream errors are relayed as in-stream SSE error frames instead of HTTP status codes, but ONLY for `stream: true` requests. `stream: false` / malformed requests keep today's behavior exactly.

## Types

No changes to `src/types.ts`. New module `src/ssePrelude.ts` exports constants and pure builders. New type:

```ts
interface SseErrorFrameInput {
  status: number;
  bodyText: string;
  retryAfter?: string | null;
}
```

Config: `HEARTBEAT_INTERVAL_MS` derived from `process.env.SSE_HEARTBEAT_INTERVAL_MS` (positive int, default 2000) — module-level, tunable so tests stay fast.

## Files

**New:**

- `src/ssePrelude.ts` — pure SSE frame builders + heartbeat config (no I/O, no Express imports).
- `tests/ssePrelude.test.ts` — unit tests for frame builders/config.

**Modified:**

- `src/routes/chatCompletions.ts` — add the optimistic `stream: true` path (details in Functions).
- `tests/integration/mockServer.ts` — add `headersDelayMs?: number` to `SseOptions` (setTimeout before `res.writeHead` in `respondSse`), simulating slow-thinking Gemini header delay.
- `tests/integration/chatCompletions.test.ts` — add `splitBootFrameAndRemainder` helper; update S1/S5/S7/S7b assertions (boot frame prefix + byte-verbatim remainder); add 4 new tests (timing, error-after-flush, JSON anomaly, early disconnect).

**Deleted:** none.

## Functions

**New (`src/ssePrelude.ts`):**

- `makeBootFrame(model?: unknown): string` — builds `data: {JSON}\n\n` where JSON = `{id: "chatcmpl-"+crypto.randomUUID(), object: "chat.completion.chunk", created: <int unix sec>, model: <string or "unknown">, choices: [{index:0, delta:{role:"assistant"}, finish_reason:null}]}`. Uses `JSON.stringify` (never string interpolation — injection-proof). No `content` field (OpenAI chunk-0 convention).
- `makeSseErrorFrame(input: SseErrorFrameInput): string` — always emits `data: {"error":{"message":string,"type":"upstream_error","code":<http status>,"retryAfter"?:string}}\n\n`. If `bodyText` parses as JSON containing `error.message`, reuse Google's nested error as the message source (`[Google <code>] <message>` + nested `details` if present); otherwise wrap a 500-char-truncated snippet.
- `HEARTBEAT_FRAME: string` = `": heartbeat\n\n"`.
- `HEARTBEAT_INTERVAL_MS: number` = `Number(process.env.SSE_HEARTBEAT_INTERVAL_MS) || 2000`.

**Modified (`src/routes/chatCompletions.ts` — stream:true path only):**

1. After patch + URL/headers: `isStreamRequest = req.body?.stream === true && Array.isArray(req.body?.messages)`. If false → EXISTING code path verbatim.
2. If true: `res.status(200)`; set headers `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no`; `res.flushHeaders()`; guarded write of `makeBootFrame(model)` (guard: `!res.writableEnded && !res.destroyed`); start `heartbeat = setInterval(guardedWriteHeartbeat, HEARTBEAT_INTERVAL_MS); heartbeat.unref()`.
3. Close listener: `res.on('close', () => { clearInterval(heartbeat); if (!res.writableEnded) ac.abort(); })` (clearInterval unconditional; abort conditional).
4. `await fetch(...)` with `ac.signal`; immediately `clearInterval(heartbeat)` once fetch settles (success OR throw).
5. Branch on upstream:
   - **200 + text/event-stream + body:** `pipeline(Readable.fromWeb(upstream.body), new SignatureTap(new SseSignatureExtractor(cache)), res)` — identical to today; pipeline errors: swallow abort/premature-close, log others, NEVER write an error frame mid-stream.
   - **!upstream.ok:** `bodyText = await upstream.text()`; `retryAfter = headers.get('retry-after')`; guarded `res.write(makeSseErrorFrame(...))`; `res.end()`; NO `[DONE]`.
   - **200 non-SSE (protocol anomaly):** guarded write of a 502 anomaly error frame; `res.end()`; no heroic JSON→chunk conversion.
   - **fetch throws:** swallow abort-class errors (`isAbortOrPrematureClose` / `ac.signal.aborted` / `res.destroyed`); else guarded write of 502 error frame + `res.end()`.
6. `stream: false` path: completely unchanged (buffered JSON forward with extraction; upstream errors verbatim with real statuses).

**Modified (`tests/integration/mockServer.ts`):** `SseOptions` gains `headersDelayMs?: number`; `respondSse` waits `setTimeout(headersDelayMs)` before `res.writeHead`.

**Removed:** none.

## Classes

- `SignatureTap`, `SseSignatureExtractor`, `SignatureCache` — unchanged. The injected boot frame is written directly to `res` and never passes through `SignatureTap` (tap only wraps `upstream.body`), so `thought_signature` caching and byte accounting are unaffected by construction.

## Dependencies

- Runtime dep additions: none (uses `node:crypto` builtin).
- New env var: `SSE_HEARTBEAT_INTERVAL_MS` (default 2000ms; tests set ~100ms).



## Testing

- **New `tests/ssePrelude.test.ts` (landed in Chunk 1):** boot frame framing/shape/role-only-delta/uuid-uniqueness/model escaping + unknown fallbacks; error frame nested-Google passthrough with `[Google <code>]` prefix, non-scalar-code guard, raw-text truncation at 500 with dangling-surrogate strip, empty/whitespace fallback, retryAfter presence rules, no `[DONE]`; heartbeat interval default 2000, floor 500, env override, float flooring.
- **Updated integration assertions (S1, S7, S7b; landed in Chunk 2):** `splitBootFrameAndRemainder(raw)` splits at the first newline-newline boundary, validates boot frame shape, and asserts the remainder (heartbeat-stripped) equals `renderSse(upstreamFrames)` byte-for-byte — the byte-verbatim guarantee holds for all real upstream bytes. S5/S6 unchanged (cache-state assertions only).
- **`stream:false` realignment:** `chatBody` gained a `stream` param. Tests whose mock responds with JSON (S2, S4, S8, S10, and the JSON follow-ups in S1/S5/S6) now post `stream: false` — streaming requests against a JSON-speaking upstream correctly hit the anomaly path instead. S4 keeps verbatim status/body/retry-after assertions for non-stream requests.
- **New S11 — timing (core proof):** upstream `headersDelayMs: 3000` with heartbeat stubbed to 500ms; first client chunk arrives in <500ms and is the boot frame; heartbeat frames observed on the wire; remainder byte-equals upstream after stripping; cache commits at `[DONE]`.
- **New S12 — error-after-flush:** upstream 400/429 with Google error JSON; stream:true client gets 200; boot frame first, then an error frame with `code` matching the upstream status, `[Google <code>]` message, and retryAfter from the upstream header; stream ends without `[DONE]`.
- **New S13 — anomaly:** upstream 200 `application/json` on stream:true → 502 `upstream_error` frame, no fabricated chunks.
- **New S14 — early disconnect:** `headersDelayMs: 1500`, client aborts at ~300ms → exactly one upstream request recorded, mock survives the dead socket, proxy serves a follow-up request cleanly.
- **New S15 — heartbeat behavior:** stub 500ms + `headersDelayMs: 1200` → client body contains `: heartbeat` comment frames before upstream bytes; remainder still byte-verbatim after stripping. Suite-wide deterministic stub: `SSE_HEARTBEAT_INTERVAL_MS=60000`.
- **Regression:** all 145 pre-v2.1.0 tests green; S3 (stream:false JSON) byte-exact forwarding untouched.
- **Gates:** `pnpm typecheck`, `pnpm test`, `pnpm build` — green (151 tests). Live verification against the Open Design retry loop pending with the user.

## Implementation Order

1. **Chunk 1 — SSE prelude module + unit tests:** create `src/ssePrelude.ts` + `tests/ssePrelude.test.ts`. No runtime behavior change; all 124 existing tests must pass unchanged. Verify: `pnpm typecheck && pnpm test && pnpm build`.
2. **Chunk 2 — Route integration + mock delay + integration suite:** modify `src/routes/chatCompletions.ts` (optimistic path), add `headersDelayMs` to mock, update S1/S5/S7/S7b assertions, add 4 new integration tests. Verify: `pnpm typecheck && pnpm test` (124 existing + ~12 new green) `&& pnpm build` + manual live verification against the Open Design retry scenario. Checkpoint commit after each chunk.
