/**
 * Core domain types for the proxy.
 *
 * These are intentionally loose and unknown-tolerant: the proxy must never
 * crash on unexpected payload shapes from either OpenAI-protocol clients or
 * Google's OpenAI-compatible endpoint. Anything we do not explicitly model
 * is carried through via index signatures and forwarded verbatim.
 */

/** A single OpenAI-format tool call, extended with Google's thought signature. */
export interface OpenAIToolCall {
  /** SSE streaming deltas correlate partial tool calls by this index. */
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  /** Documented wire location for Gemini thought signatures. */
  extra_content?: {
    google?: {
      thought_signature?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  /** Defensive alternate location seen on some Gemini wire formats. */
  thought_signature?: string;
  [key: string]: unknown;
}

/** An OpenAI-format chat message. */
export interface OpenAIMessage {
  role?: string;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
}

/** Inbound /chat/completions request body (fields we care about + passthrough). */
export interface ChatCompletionBody {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

/**
 * Signature cache value:
 * - string: real thought_signature captured from Google — re-inject verbatim.
 * - null: known "unsigned parallel sibling" — Gemini signs only the first
 *   tool-call part in a parallel batch; siblings must go back unsigned.
 */
export type CacheEntry = string | null;

/** Three-state cache lookup result. "miss" means id unknown to the cache. */
export type CacheLookup =
  | { state: "signed"; value: string }
  | { state: "unsigned" }
  | { state: "miss" };

/** Per-tool-call accumulator used while parsing streaming responses. */
export interface ToolCallAccumulator {
  /** SSE tool-call delta index this accumulator is tracking. */
  index?: number;
  id?: string;
  signature?: string;
  [key: string]: unknown;
}

/** Runtime configuration for the proxy. */
export interface ProxyConfig {
  port: number;
  host: string;
  /** Upstream base URL, no trailing slash (e.g. https://generativelanguage.googleapis.com). */
  upstreamBaseUrl: string;
  /**
   * Decides whether the sentinel fallback applies to a model on cache miss.
   * Injection of real cached signatures is NOT gated by this — only the
   * "skip_thought_signature_validator" sentinel on a true cache miss.
   */
  shouldPatchModel: (model?: unknown) => boolean;
  /** Human-readable description of the model filter, for the startup banner. */
  modelFilterDescription: string;
  cacheMaxEntries: number;
  cacheTtlMs: number;
}
