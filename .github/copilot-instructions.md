# Copilot Instructions for `gemini-thought-signature-proxy`

## Project Overview
This project is a lightweight, local Node.js proxy designed to solve a specific compatibility issue between VS Code Insiders and Google's Gemini 3.1 Pro Preview model.

When using GitHub Copilot's "Bring Your Own Key" (BYOK) feature to connect directly to Gemini via an OpenAI-compatible endpoint, standard chat works fine. However, using **Agent mode** (tool/function calling) immediately fails with a `400 INVALID_ARGUMENT: Function call is missing a thought_signature` error.

This happens because Gemini 3.1 attaches a cryptographic signature to its internal reasoning ("thinking") before calling a tool. VS Code's Copilot extension, acting as a standard OpenAI client, strips out this non-standard signature field. When the next request is sent back to Google without the signature, Google rejects it.

This proxy sits between VS Code and Google, intercepting the requests and injecting Google's official bypass sentinel (`skip_thought_signature_validator`) into the tool calls. This tricks Google into accepting the request without the signature, allowing the user to fully utilize Gemini 3.1 Pro's Agent mode capabilities directly within VS Code Insiders.

## Core Logic & Architecture
- **Entry Point:** `cli.js` (for `npx` execution) which imports `proxy.js`.
- **Main Logic:** `proxy.js` (Express server).
- **Port:** Defaults to `3000` (can be overridden via `process.env.PORT`).
- **Target:** `https://generativelanguage.googleapis.com`
- **Patched Model:** `models/gemini-3.1-pro-preview-customtools` (Only this model gets the injection; others pass through untouched).
- **Bypass Sentinel:** `skip_thought_signature_validator`

### The Injection Mechanism
The core function `injectThoughtSignatures(messages)` walks the OpenAI-format `messages` array. It looks for messages where `role === "assistant"` and that contain `tool_calls`. For each tool call, if the `extra_content.google.thought_signature` is missing, it injects the bypass sentinel.

### Path Routing Quirk
VS Code constructs the final URL by appending `v1/chat/completions` to the base URL provided in `chatLanguageModels.json`. If the base URL is `http://localhost:3000/v1beta/openai/`, VS Code sends requests to `/v1beta/openai/v1/chat/completions`. However, the actual Google endpoint is `/v1beta/openai/chat/completions` (no extra `/v1`). The proxy explicitly intercepts the VS Code path (`/v1beta/openai/v1/chat/completions`) and rewrites the upstream target to the correct Google path.

### Catch-all Passthrough
All other requests (e.g., token counting, model listing) hit the `app.all("*")` route. These are forwarded to Google unchanged, preserving only the `authorization`, `content-type`, and `accept` headers. No signature patching is applied here.

## Development Guidelines
- **Dependencies:** Keep dependencies minimal. Currently relies only on `express` and `node-fetch`.
- **Statelessness:** The proxy must remain completely stateless. Do not store API keys, conversation history, or any user data.
- **Error Handling:** Ensure robust error handling. If the upstream request fails, the proxy should gracefully return a `502 Bad Gateway` with details, rather than crashing.
- **Logging:** Keep logging informative but concise. Log the interception and injection events, but avoid logging sensitive information like API keys or full message payloads.
- **Testing:** When testing changes, ensure both the patched model (`models/gemini-3.1-pro-preview-customtools`) and other models are tested to verify the conditional injection logic works correctly.

## Important Context for AI Agents
- **Do not modify the core injection logic** unless Google changes their API requirements or introduces a new model that requires the same patch.
- **Do not add features that require state.** The proxy's strength is its simplicity and statelessness.
- **When updating documentation (README.md),** ensure the instructions for configuring VS Code Insiders (`chatLanguageModels.json` and the `Chat: Manage Language Models` command) remain clear and accurate.
- **The `.npmignore` and `.gitignore` files** are configured to exclude personal markdown files (`tweets.md`, `reddit-post.md`, `github-issue.md`). Do not remove these exclusions.