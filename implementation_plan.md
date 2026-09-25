# Implementation Plan

**Status: Completed (v2.0.0)** — all 7 chunks landed, verified, and committed. Kept as an architectural record.

## Overview

Upgrade the proxy from a stateless sentinel-injector to a stateful signature-preserving proxy, migrated to modern TypeScript/ESM. It sits between OpenAI-protocol clients (Open Design / Vercel AI SDK, VS Code Copilot BYOK) and Google's OpenAI-compatible Gemini endpoint, caching real `thought_signature` values from Google responses (SSE and JSON) and re-injecting them into outbound request history.

Core cache invariant: `string` -> inject real signature | `null` -> leave unsigned (parallel sibling; Gemini signs only the first tool-call part) | `undefined` (miss) -> inject `skip_thought_signature_validator` sentinel if model matches.

Key rules carried from review:
- Cache `null` for a sibling ONLY when at least one tool call in the same choice group carried a real signature; groups with zero signatures cache nothing.
- Commit signatures the moment `data: [DONE]` is parsed (clients abort right after). No `[DONE]` at EOF -> discard accumulators; never cache speculative nulls.
- SSE parsing: remainder buffer across chunks, split on /\r?\n\r?\n/, cheap substring guard before JSON.parse, accumulators keyed `${choiceIndex}:${toolCallIndex}`.
- Header hygiene: strip `host`/`content-length` (recomputed after patching), set `accept-encoding: identity`, forward query strings and `x-goog-api-key`, hop-by-hop denylist.
- Forward upstream error statuses (400/429) verbatim; never mask with proxy 502.
- Bind `127.0.0.1` by default.

## Types

`src/types.ts`:
- `OpenAIToolCall`: `id?`, `type?`, `function? {name?, arguments?}`, `extra_content?.google?.thought_signature?`, defensive `thought_signature?`, `[key: string]: unknown`.
- `OpenAIMessage`: `role?`, `tool_calls?: OpenAIToolCall[]`, index signature.
- `ChatCompletionBody`: `model?`, `messages?`, `stream?`, index signature.
- `CacheEntry = string | null`
- `CacheLookup = {state:'signed';value:string} | {state:'unsigned'} | {state:'miss'}`
- `ToolCallAccumulator = {id?: string; signature?: string}`
- `ProxyConfig`: `port, host, upstreamBaseUrl, shouldPatchModel(model?), cacheMaxEntries, cacheTtlMs`

## Files

New:
- `src/types.ts`, `src/config.ts`, `src/cache.ts`, `src/inject.ts`, `src/extract.ts`, `src/stream.ts`
- `src/routes/chatCompletions.ts`, `src/routes/passthrough.ts`
- `src/proxy.ts`, `src/cli.ts`
- `tsconfig.json`, `vitest.config.ts`, `implementation_plan.md`
- `tests/config.test.ts`, `tests/cache.test.ts`, `tests/inject.test.ts`, `tests/extract.test.ts`, `tests/stream.test.ts`
- `tests/integration/mockServer.ts`, `tests/integration/chatCompletions.test.ts`, `tests/integration/passthrough.test.ts`

Modified: `package.json` (scripts/deps/bin/main/files), `README.md` (v2 usage, env reference).

Deleted: `proxy.js`, `cli.js` (superseded), `package-lock.json` (pnpm-only).

## Functions

- `loadConfig(env?): ProxyConfig` (src/config.ts) - pure env parser. `PORT`=3000, `HOST`=127.0.0.1, `UPSTREAM_BASE_URL`=generativelanguage.googleapis.com (trailing slash stripped; overridable for tests), `PATCHED_MODELS` comma-separated exact IDs else default `/gemini/i`, `CACHE_MAX_ENTRIES`=5000, `CACHE_TTL_MS`=1h.
- `patchMessages(messages, cache, shouldPatchModel): OpenAIMessage[]` (src/inject.ts) - non-mutating; assistant messages with tool_calls only; skip no-id; preserve already-signed; string -> inject extra_content.google.thought_signature; null -> leave unsigned; miss + model match -> inject sentinel; miss + no match -> untouched.
- `extractFromJsonResponse(body: unknown, cache): void` (src/extract.ts) - guards Array.isArray(body?.choices); per-choice sibling-null rule; dual-path read (extra_content.google.thought_signature || thought_signature).
- `createProxyApp(config): Express` (src/proxy.ts) - express.json({limit:'50mb'}), routes, passthrough.
- `handleChatCompletions(req,res,cache,config)` (src/routes/chatCompletions.ts) - BOTH `POST /v1beta/openai/chat/completions` (Open Design) and `POST /v1beta/openai/v1/chat/completions` (VS Code) -> upstream `{BASE}/v1beta/openai/chat/completions`, query string preserved. SSE -> pipeline(Readable.fromWeb(upstream.body), tap, res); JSON -> read text, extract, forward verbatim. Non-2xx forwarded as-is. res.on('close') aborts upstream fetch.
- `handlePassthrough(req,res,config)` (src/routes/passthrough.ts) - catch-all app.all('*'), denylist headers, streaming both directions.

Removed: `injectThoughtSignatures` (proxy.js) superseded by `patchMessages`; constant `PATCHED_MODEL_ID` replaced by `shouldPatchModel` matcher.

## Classes

- `SignatureCache` (src/cache.ts): Map<string,{value, expiresAt}>. `get(id): CacheLookup` (lazy expiry + LRU touch), `set(id, value)` (string never downgraded to null; evict-oldest at cap), background sweep via unref'd setInterval. Keys: tool_call ids only - never message content or API keys.
- `SseSignatureExtractor` (src/extract.ts): `feed(text)` with remainder buffer; split /\r?\n\r?\n/; includes('tool_calls') guard before JSON.parse; per `${choiceIndex}:${toolCallIndex}` accumulators; commit immediately on `data: [DONE]` with per-choice sibling-null rule; idempotent `finish()` discards if no [DONE].
- `SignatureTap extends Transform` (src/stream.ts): StringDecoder -> extractor.feed; `callback(null, chunk)` for backpressure (bytes forwarded verbatim, zero buffering); `_flush` -> extractor.finish(); AbortController for upstream teardown on client disconnect.

## Dependencies

- Keep: `express`.
- Drop: `node-fetch` (native fetch on Node 23).
- DevDeps: `typescript`, `tsx`, `vitest`, `@types/express`, `@types/node`.
- Lockfile: `pnpm-lock.yaml` only; `package-lock.json` deleted.

## Testing

Vitest with a local mock-HTTP upstream (never hits Google).
- Unit: cache (three states, TTL, LRU cap, no string->null downgrade); inject (all branches incl. existing-signature preserved, non-gemini pass-through); extractors (parallel signed/unsigned siblings, zero-signature groups not cached, dual wire paths, malformed frames ignored, 7-byte mid-frame slicing, CRLF+LF, [DONE] immediate commit).
- Integration: byte-verbatim SSE forwarding; round-trip (stream -> cache -> next request carries real sig / unsigned sibling / sentinel); JSON non-stream round-trip; sentinel only for gemini models; upstream 400/429 unmasked; passthrough query/headers.
- Final gates: `pnpm build`, `pnpm test`, boot `node dist/cli.js` + smoke curl.

## Implementation Order

1. Chunk 1 - Scaffolding: package.json, tsconfig.json, vitest.config.ts, src/types.ts, src/config.ts + config test; delete proxy.js, cli.js, package-lock.json. Verify: `pnpm install && pnpm typecheck`.
2. Chunk 2 - Cache + Inject: src/cache.ts, src/inject.ts + unit tests.
3. Chunk 3 - Extractors: src/extract.ts (JSON + SSE) + unit tests.
4. Chunk 4 - Stream tap + routes: src/stream.ts, src/routes/* + header/abort tests.
5. Chunk 5 - App factory + CLI: src/proxy.ts, src/cli.ts; bin -> dist/cli.js; boot check.
6. Chunk 6 - Integration tests: mock upstream, end-to-end round-trips.
7. Chunk 7 - README + final gate: pnpm build && pnpm test clean.
