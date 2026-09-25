import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { SignatureCache } from "./cache.js";
import { createChatCompletionsHandler } from "./routes/chatCompletions.js";
import { createPassthroughHandler } from "./routes/passthrough.js";
import type { ProxyConfig } from "./types.js";

export interface ProxyApp {
  app: Express;
  cache: SignatureCache;
}

export interface ProxyAppOptions {
  /** express.json body limit for chat routes. Tests inject tiny limits. */
  jsonLimit?: string;
}

interface BodyParserError {
  type?: string;
  status?: number;
  statusCode?: number;
  message?: string;
}

function openAiError(code: string, message: string, type = "invalid_request_error") {
  return { error: { message, type, param: null, code } };
}

/**
 * Assembles the proxy application.
 *
 * Mounting order matters:
 *  1. /healthz — never proxied upstream.
 *  2. Chat routes get express.json() SCOPED to them; the passthrough must
 *     keep its body as a raw stream (or it would be buffered + reserialized).
 *  3. The 4-arg error middleware goes LAST and translates body-parser
 *     failures into OpenAI-shaped JSON instead of Express's default HTML.
 */
export function createProxyApp(config: ProxyConfig, options: ProxyAppOptions = {}): ProxyApp {
  const cache = new SignatureCache({
    maxEntries: config.cacheMaxEntries,
    ttlMs: config.cacheTtlMs,
  });

  const app = express();
  app.disable("x-powered-by");
  app.locals["cache"] = cache;

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  const jsonParser = express.json({ limit: options.jsonLimit ?? "50mb" });
  const chatHandler = createChatCompletionsHandler(cache, config);
  app.post("/v1beta/openai/chat/completions", jsonParser, chatHandler);
  app.post("/v1beta/openai/v1/chat/completions", jsonParser, chatHandler);

  app.all("*", createPassthroughHandler(config));

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const parserErr = err as BodyParserError;
    const status =
      typeof parserErr.status === "number"
        ? parserErr.status
        : typeof parserErr.statusCode === "number"
          ? parserErr.statusCode
          : 500;

    // Malformed JSON in the request body (body-parser 1.20.x).
    if (
      parserErr.type === "entity.parse.failed" ||
      (err instanceof SyntaxError && status === 400 && "body" in (err as object))
    ) {
      res.status(400).json(openAiError("invalid_json", parserErr.message ?? "Invalid JSON body"));
      return;
    }
    if (parserErr.type === "entity.too.large" || status === 413) {
      res
        .status(413)
        .json(openAiError("payload_too_large", parserErr.message ?? "Payload too large"));
      return;
    }

    console.error("[proxy] unhandled request error:", err);
    // Forward a meaningful upstream-style status when the error carries one;
    // never mask a 502/504 as a generic 500.
    const safeStatus = status >= 400 && status < 600 ? status : 500;
    res
      .status(safeStatus)
      .json(openAiError("proxy_error", parserErr.message ?? "Internal proxy error", "api_error"));
  });

  return { app, cache };
}
