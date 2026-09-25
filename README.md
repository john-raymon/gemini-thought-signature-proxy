# Gemini Thought Signature Proxy

```
400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts.
```

A tiny local proxy that sits between your OpenAI-protocol client and Google's OpenAI-compatible Gemini endpoint, preserving the `thought_signature` fields that Gemini 3.x models require for tool calling — so multi-turn agent loops stop dying with the 400 above.

## The problem

Gemini 3.x models (3.8 Flash, 3.1 Pro, …) sign their reasoning before emitting a tool call. Google's OpenAI-compatible endpoint returns that signature inside each tool call at a non-standard location:

```json
"extra_content": { "google": { "thought_signature": "..." } }
```

Standard OpenAI clients — the Vercel AI SDK (Open Design), VS Code Copilot BYOK, the OpenAI Python/Node SDKs — deserialize the response into their own types and **strip non-standard fields**. When the tool result goes back on the next turn, the history no longer contains the signature, and Google rejects the request with the 400 error.

One more wrinkle: for **parallel tool calls**, Gemini attaches the signature to the **first** tool-call part only. The sibling calls arrive unsigned and must be returned unsigned.

## How v2 fixes it

The proxy keeps an in-memory cache (`tool_call.id → thought_signature`) and applies a strict three-state rule on every turn:

| Cache state | Meaning | Outbound action |
|---|---|---|
| `string` | Real signature captured from Google | Inject it back into `extra_content.google.thought_signature` |
| `null` | Known **unsigned parallel sibling** | Forward **exactly as received** — unsigned |
| miss | Never seen (restart, eviction, handoff) | Inject Google's documented bypass sentinel `skip_thought_signature_validator` — **only** for models matching the model filter |

Extraction is model-agnostic (harmless no-op for non-Gemini traffic); only the sentinel fallback is gated — by default to any model id matching `/gemini/i`, overridable with an exact list via `PATCHED_MODELS`.

```text
[ Client (Open Design / Vercel AI SDK / VS Code / SDKs) ]
                        |  chat/completions
                        v
        [ gemini-thought-signature-proxy ]
         1. scan assistant tool_calls in history
         2. inject cached sig / leave sibling bare / sentinel
         3. strip hop-by-hop headers, recompute framing
                        v
        [ Google generativelanguage.googleapis.com ]
                        |  response (SSE or JSON)
                        v
        [ gemini-thought-signature-proxy ]
         1. bytes forwarded to client VERBATIM
         2. side-channel parser extracts signatures
         3. commit to cache at [DONE] (aborted turn = discard)
                        v
                     [ Client ]
```

## Quick start

No install needed:

```bash
# preferred
pnpm dlx gemini-thought-signature-proxy

# or
npx gemini-thought-signature-proxy
```

The proxy listens on `http://127.0.0.1:3000` and prints its upstream, model filter, and cache settings at boot. `GET /healthz` returns `{"status":"ok"}`.

## Client configuration

### Open Design / Vercel AI SDK

Point the provider's base URL at the proxy — the SDK appends `/chat/completions` itself:

```typescript
import { createOpenAI } from "@ai-sdk/openai";

const gemini = createOpenAI({
  baseURL: "http://localhost:3000/v1beta/openai",
  apiKey: process.env.GEMINI_API_KEY,
});

const model = gemini("gemini-3.8-flash");
```

### OpenAI Python SDK

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1beta/openai",
    api_key=os.environ["GEMINI_API_KEY"],
)
```

### VS Code Copilot BYOK

VS Code appends `v1/chat/completions` to the configured base URL, producing `/v1beta/openai/v1/chat/completions`. The proxy mounts **both** that path and the plain `/v1beta/openai/chat/completions`, rewriting to Google's real upstream path either way — configure exactly as before:

```json
[
  {
    "name": "OpenAI Compatible",
    "vendor": "customoai",
    "apiKey": "",
    "models": [
      {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash",
        "url": "http://localhost:3000/v1beta/openai/",
        "toolCalling": true,
        "vision": true,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 66000
      }
    ]
  }
]
```

Then set your API key via **`Chat: Manage Language Models`** in the command palette.


## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the proxy listens on |
| `HOST` | `127.0.0.1` | Bind address. Loopback by default — do not expose this proxy to a network |
| `UPSTREAM_BASE_URL` | `https://generativelanguage.googleapis.com` | Upstream Gemini endpoint (override for testing) |
| `PATCHED_MODELS` | *(unset)* | Comma-separated exact model IDs eligible for the sentinel fallback (e.g. `gemini-3.8-flash,gemini-3.1-pro`). A `models/` prefix is tolerated on either side. When unset, any id matching `/gemini/i` is eligible |
| `CACHE_MAX_ENTRIES` | `5000` | Max cached signatures (LRU eviction beyond this) |
| `CACHE_TTL_MS` | `3600000` | Signature time-to-live in milliseconds (1 hour) |

Real cached signatures are injected for **any** model regardless of this filter — the filter only gates the sentinel fallback on cache misses.

## Technical details

- **Streaming integrity:** SSE responses pass through a `SignatureTap` transform that forwards every byte to the client unmodified (proper backpressure, multi-byte UTF-8 safe) while a side-channel parser extracts signatures. Zero added latency; token-by-token streaming is unaffected.
- **Commit semantics:** signatures commit to the cache the moment `data: [DONE]` arrives — clients that disconnect immediately after (as the Vercel AI SDK does) still get their signatures cached. A stream that ends **without** `[DONE]` (aborted turn, upstream error mid-stream) discards everything it saw, so speculative partial state can never poison the cache.
- **Non-stream responses:** JSON chat completions are buffered, signatures extracted, and the **original upstream bytes** are forwarded unmodified (never re-serialized).
- **Header hygiene:** hop-by-hop headers (`host`, `content-length`, `connection`, …) are stripped and recomputed; `accept-encoding` is forced to `identity` upstream so the SSE parser never sees compressed bytes; upstream errors (400/429/…) are forwarded verbatim — never masked by a proxy 500.
- **Cache:** in-memory LRU with fixed TTL and a background sweep. Keys are `tool_call.id`s only.

## Privacy

- Binds to `127.0.0.1` by default; the proxy is only reachable from your machine.
- API keys are forwarded to Google and **never logged or stored**.
- Message contents are never logged; the only persisted state is `tool_call.id → signature` in memory (gone on restart).
- Logs are limited to routes, models, and extraction counts.

## Development

```bash
pnpm install        # pnpm only — no npm/yarn
pnpm typecheck      # tsc --noEmit
pnpm build          # emit dist/ (cli.js marked executable)
pnpm test           # vitest: unit + mock-upstream integration suites
pnpm dev            # run from source via tsx
```

Repo layout: `src/config.ts` (env), `src/cache.ts` (LRU+TTL store), `src/inject.ts` (outbound injection), `src/extract.ts` (JSON + SSE extraction), `src/stream.ts` (SignatureTap), `src/routes/` (chat + passthrough + header utils), `src/proxy.ts` (app factory), `src/cli.ts` (entrypoint).

## When this might stop working

If Google changes sentinel semantics, the wire location of `thought_signature`, or parallel-call validation rules after GA, the extractor/injector logic will need updating. The defensive bits (dual wire-path reads, sentinel fallback) are designed to degrade gracefully rather than hard-fail.

## References

- [Google's official thought signatures docs](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Vercel AI SDK](https://sdk.vercel.ai/)
