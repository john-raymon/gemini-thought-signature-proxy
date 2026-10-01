# Open Design Integration & Gemini Interactions Architecture

This document summarizes the architecture, configuration, and operational findings when integrating Google Gemini models with Open Design (0.24.x).

---

## 1. Two Architectural Approaches

### A. HTTP Proxy (`gemini-thought-signature-proxy`)
- **Protocol**: OpenAI-compatible chat completions proxy (`/v1beta/openai/chat/completions`).
- **Open Design Setting**: Requires **"Custom Provider"** (OpenAI-compatible) with Base URL pointed to `http://localhost:3000/v1beta/openai`.
- **Purpose**: Intercepts OpenAI-format requests, injects thought signatures, and delivers an optimistic SSE prelude to keep clients from timing out while Gemini generates thoughts.
- **Limitation**: Open Design resends full conversation history on every turn. In long-running design sessions with dozens of tool calls, prompt token counts compound rapidly (reaching 70k+ tokens per turn), burning through Gemini TPM limits quickly.

### B. In-Process Interactions Provider (`gemini-interactions-provider`)
- **Protocol**: Google Gemini Interactions API (`/v1beta/interactions`) via LanguageModelV3.
- **Open Design Setting**: Uses the native **Google Gemini** preset. Base URL remains Google's default (`https://generativelanguage.googleapis.com`).
- **Mechanism**: Open Design's daemon runtime (`apps/daemon/chunks/chunk-53H6ASZW.mjs`) is patched to load the local bundle (`npm: "file:///.../gemini-interactions-provider/dist/index.js"`) instead of `@ai-sdk/google`.
- **Advantage**: Uses server-side interaction state (`previous_interaction_id`). On subsequent turns, only the **delta** (the new user message or tool result) is transmitted across the wire, dramatically slashing token-per-minute (TPM) consumption by 90%+.

---

## 2. Configuration in Open Design Settings

| Field | Value | Notes |
| :--- | :--- | :--- |
| **Provider Preset** | **Google Gemini** | Do not select "Custom Provider" when using `gemini-interactions-provider`. |
| **Base URL** | `https://generativelanguage.googleapis.com` | Default is correct. Do not set to localhost. |
| **API Key** | Your Google Gemini API Key | Stored securely in Open Design config. |
| **Model** | `gemini-3.7-flash` or `gemini-3.8-flash` | Selected from your account. |

### Note on the "Test" Button
The "Test" button in Open Design BYOK settings issues a direct smoke test via `:generateContent` (`googleGenerateContentUrl`) using Node's native `fetch`. It completely bypasses the agent runtime and `gemini-interactions-provider`. Because of this:
- The test request appears as **"generate content"** in Google AI Studio logs.
- It does **not** write to `~/.cache/gemini-interactions-provider/debug.log`.
- `gemini-interactions-provider` is only invoked when you prompt the agent to create or edit a design on a canvas or project chat.

---

## 3. Tool Calling & Schema Recovery

During long-running agent workflows, the model may occasionally emit non-standard parameter names (e.g. `search_term` instead of `pattern` for the `grep` tool).

- OpenCode's schema validator intercepts these and returns structured feedback:
  ```
  SchemaError(Missing key at ["pattern"]). Please rewrite the input so it satisfies the expected schema.
  ```
- **Self-Healing Loop**: The agent reads this error feedback and immediately self-corrects on the subsequent turn by supplying the canonical parameter.
- **Provider Resilience**: If an invalid turn causes a continuation hiccup on Google's Interactions endpoint, `gemini-interactions-provider` invalidates the cached continuation ID and transparently falls back to a full-prompt retry within ~3 seconds, allowing the agent to complete the task without user intervention.
