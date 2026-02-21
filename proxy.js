/**
 * proxy.js
 *
 * Gemini 3.1 "thought_signature" bypass proxy for VS Code Copilot BYOK.
 *
 * PROBLEM:
 *   Gemini 3.1 Pro requires a `thought_signature` field inside every
 *   tool_call it previously generated. VS Code Copilot is a vanilla
 *   OpenAI client — it discards that non-standard field when forwarding
 *   the conversation history, causing Google to return:
 *     400 INVALID_ARGUMENT: Function call is missing a thought_signature.
 *
 * SOLUTION (stateless bypass):
 *   Before forwarding any request to Google, iterate the `messages` array
 *   and, for every assistant message that contains `tool_calls`, inject
 *     extra_content.google.thought_signature = "skip_thought_signature_validator"
 *   into each tool call that is missing the field. Google documents this
 *   sentinel value as an explicit bypass for the signature validator.
 *
 * USAGE:
 *   1. cd tools/gemini-proxy && npm install
 *   2. node proxy.js
 *   3. Point VS Code chatLanguageModels.json → http://localhost:3000
 */

import express from "express";
import fetch from "node-fetch";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Google's documented sentinel that tells the thought_signature validator
 * to skip enforcement when the original signature is unavailable.
 */
const BYPASS_SIGNATURE = "skip_thought_signature_validator";

/**
 * The only model ID that requires thought_signature injection.
 * Other models routed through this proxy are forwarded without modification.
 */
const PATCHED_MODEL_ID = "models/gemini-3.1-pro-preview-customtools";

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

// 50 MB limit — Gemini conversations with many tool results can be large.
app.use(express.json({ limit: "50mb" }));

// ---------------------------------------------------------------------------
// Core injection logic
// ---------------------------------------------------------------------------

/**
 * Walks the messages array and injects the bypass thought_signature into
 * every assistant tool_call that is missing one.
 *
 * @param {Array<object>|undefined} messages - The OpenAI-format messages array.
 * @returns {Array<object>} - The patched messages array (original is not mutated).
 */
function injectThoughtSignatures(messages) {
  // Guard: if messages is absent or malformed, return it unchanged.
  if (!Array.isArray(messages)) return messages;

  return messages.map((message) => {
    // Only assistant messages with tool_calls need patching.
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return message;
    }

    const patchedToolCalls = message.tool_calls.map((toolCall) => {
      // If the signature is already present (e.g. passed through on an earlier
      // hop), leave the tool call untouched.
      const existingSignature = toolCall?.extra_content?.google?.thought_signature;
      if (existingSignature) return toolCall;

      // Inject the bypass sentinel.
      return {
        ...toolCall,
        extra_content: {
          google: {
            thought_signature: BYPASS_SIGNATURE,
          },
        },
      };
    });

    return { ...message, tool_calls: patchedToolCalls };
  });
}

// ---------------------------------------------------------------------------
// Primary intercept route
// ---------------------------------------------------------------------------

/**
 * POST /v1beta/openai/v1/chat/completions
 *
 * VS Code appends the standard OpenAI path "v1/chat/completions" to the base
 * URL from chatLanguageModels.json ("http://localhost:3000/v1beta/openai/"),
 * resulting in "/v1beta/openai/v1/chat/completions". The upstream Google
 * endpoint lives at "/v1beta/openai/chat/completions" (no extra "/v1"), so
 * we intercept VS Code's path and forward to the correct Google path.
 *
 * 1. Parse the incoming body.
 * 2. Patch assistant tool_calls in the messages history (model-gated).
 * 3. Forward to the correct Google endpoint with the original API key.
 * 4. Stream the response back to VS Code verbatim.
 */
app.post("/v1beta/openai/v1/chat/completions", async (req, res) => {
  try {
    const body = req.body ?? {};

    // Destructure so we can replace messages without touching other params.
    const { messages, model, ...rest } = body;

    // Only inject signatures for the specific model that requires it.
    // All other models are forwarded with their messages untouched.
    const requiresPatch = model === PATCHED_MODEL_ID;
    const patchedMessages = requiresPatch ? injectThoughtSignatures(messages) : messages;

    if (requiresPatch) {
      console.log(`[proxy] ✓ Injecting thought_signature bypass for model: ${model}`);
    }

    const upstreamUrl = `${GOOGLE_BASE_URL}/v1beta/openai/chat/completions`;

    // Only forward headers that Google needs; strip anything that would
    // confuse the upstream (e.g. host, content-length — node-fetch resets those).
    const forwardHeaders = {
      "content-type": req.headers["content-type"] || "application/json",
    };

    if (req.headers["authorization"]) {
      forwardHeaders["authorization"] = req.headers["authorization"];
    }

    console.log(
      `[proxy] → POST ${upstreamUrl}  |  model: ${model ?? "unknown"}  |  messages: ${patchedMessages?.length ?? 0}`,
    );

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify({ messages: patchedMessages, model, ...rest }),
    });

    // Forward the upstream HTTP status.
    res.status(upstreamResponse.status);

    // Forward content-type so VS Code can parse the body correctly.
    const ct = upstreamResponse.headers.get("content-type");
    if (ct) res.set("content-type", ct);

    // Pipe the body — this works for both JSON and SSE streaming responses.
    upstreamResponse.body.pipe(res);
  } catch (err) {
    console.error("[proxy] ✖ Error in /chat/completions handler:", err);
    res.status(502).json({ error: "proxy_error", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Catch-all passthrough for every other path
// ---------------------------------------------------------------------------

/**
 * All other requests (token counting, model listing, etc.) are forwarded
 * to Google unchanged — only the Authorization / content-type headers are
 * preserved; no signature patching is applied.
 */
app.all("*", async (req, res) => {
  try {
    // Reconstruct the full upstream URL including any query string.
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const upstreamUrl = `${GOOGLE_BASE_URL}${req.path}${qs}`;

    // Allowlist of headers to forward.
    const forwardHeaders = {};
    for (const header of ["authorization", "content-type", "accept"]) {
      if (req.headers[header]) {
        forwardHeaders[header] = req.headers[header];
      }
    }

    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
    };

    // Attach a body for methods that support one.
    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    console.log(`[proxy] → ${req.method} ${upstreamUrl}`);

    const upstreamResponse = await fetch(upstreamUrl, fetchOptions);

    res.status(upstreamResponse.status);
    const ct = upstreamResponse.headers.get("content-type");
    if (ct) res.set("content-type", ct);

    upstreamResponse.body.pipe(res);
  } catch (err) {
    console.error("[proxy] ✖ Error in passthrough handler:", err);
    res.status(502).json({ error: "proxy_error", details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("");
  console.log(`  ┌─────────────────────────────────────────────────────┐`);
  console.log(`  │  Gemini thought_signature bypass proxy               │`);
  console.log(`  │  Listening → http://localhost:${PORT}                   │`);
  console.log(`  │  Forwarding → ${GOOGLE_BASE_URL}  │`);
  console.log(`  │  Injecting "${BYPASS_SIGNATURE}"  │`);
  console.log(`  └─────────────────────────────────────────────────────┘`);
  console.log("");
  console.log(`  To verify the proxy is working, you can run this curl command:`);
  console.log(`  (We do not store or log your API key)`);
  console.log("");
  console.log(`  curl -s http://localhost:${PORT}/v1beta/openai/models \\`);
  console.log(`    -H "Authorization: Bearer YOUR_GOOGLE_AI_STUDIO_GEMINI_API_KEY"`);
  console.log("");
  console.log(`  Make sure your chatLanguageModels.json is configured like this:`);
  console.log(`  {`);
  console.log(`    "id": "models/gemini-3.1-pro-preview-customtools",`);
  console.log(`    "name": "Gemini 3.1 Pro Preview Custom Tools",`);
  console.log(`    "url": "http://localhost:${PORT}/v1beta/openai/",`);
  console.log(`    "toolCalling": true,`);
  console.log(`    "vision": true,`);
  console.log(`    "maxInputTokens": 1000000,`);
  console.log(`    "maxOutputTokens": 66000`);
  console.log(`  }`);
  console.log("");
});
