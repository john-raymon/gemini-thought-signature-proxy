# [BYOK Agent Mode] Gemini 3.1 Pro returns 400 "Function call is missing a thought_signature" — OpenAI-compatible client strips required field

## Environment

- **Version of VS Code:** VS Code Insiders (latest)
- **Version of copilot-chat extension:** `0.38.2026022002`
- **Operating System:** macOS (or Windows/Linux)
- **LLM Model:** `models/gemini-3.1-pro-preview-customtools` via `https://generativelanguage.googleapis.com/v1beta/openai/`

## Steps to reproduce

1. Set up GitHub Copilot BYOK in VS Code Insiders (since BYOK is currently only available there) using the Google Gemini OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`).
2. Select the `models/gemini-3.1-pro-preview-customtools` model.
3. Try to use Agent mode (tool/function calling) in Copilot Chat.
4. It breaks on the second turn of the conversation.

## Actual behavior

You immediately get hit with this error:

```
400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts.
```

## Root cause analysis

Gemini 3.1 does a "thinking" step before it generates tool calls. Google cryptographically signs this reasoning and attaches the signature to any tool call the model returns, stuffing it into a non-standard field:
`choices[0].message.tool_calls[N].extra_content.google.thought_signature`

Since VS Code's Copilot extension is a standard OpenAI client, it just drops this non-standard `extra_content` field entirely. On the next turn, when VS Code sends the tool result back to Google, the conversation history is missing the signature. Google sees the missing signature and rejects the request with a 400.

## Expected behavior

Either VS Code should pass through unknown fields on assistant messages without stripping them, OR Google shouldn't strictly require the signature from clients hitting their OpenAI-compatible endpoint.

## Workaround

I threw together a quick local Node proxy that intercepts the requests and injects Google's documented bypass sentinel (`skip_thought_signature_validator`) into the tool calls before forwarding them to Google.

You can run it via npx:

```bash
npx gemini-thought-signature-proxy
```

Then just update your `chatLanguageModels.json` to point to the proxy:

```json
"url": "http://localhost:3000/v1beta/openai/"
```

## Additional note

While debugging this, I noticed VS Code constructs the final URL by appending `v1/chat/completions` to the base URL in `chatLanguageModels.json`. So with a base of `http://localhost:3000/v1beta/openai/`, VS Code sends requests to `/v1beta/openai/v1/chat/completions`. The actual Google endpoint is `/v1beta/openai/chat/completions` (no extra `/v1`). Just a secondary routing quirk worth mentioning.
