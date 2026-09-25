import type { ProxyConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_UPSTREAM_BASE_URL = "https://generativelanguage.googleapis.com";
export const DEFAULT_CACHE_MAX_ENTRIES = 5000;
export const DEFAULT_CACHE_TTL_MS = 3_600_000; // 1 hour

/**
 * Google's documented sentinel that tells the thought_signature validator to
 * skip enforcement when the original signature is unavailable (cache miss).
 */
export const BYPASS_SIGNATURE = "skip_thought_signature_validator";

/** Fallback matcher when PATCHED_MODELS is not set. */
const DEFAULT_MODEL_PATTERN = /gemini/i;

/**
 * Google sends model IDs both with and without the "models/" prefix
 * (e.g. "gemini-2.0-flash" vs "models/gemini-2.0-flash"). Trim first —
 * clients sometimes pad the model field — then normalize before comparing
 * so an exact-ID list works either way.
 */
function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

/**
 * Strict positive-integer parse: rejects floats, garbage suffixes, zero and
 * negatives, falling back to the provided default.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function parsePort(raw: string | undefined): number {
  const value = parsePositiveInt(raw, DEFAULT_PORT);
  return value >= 1 && value <= 65535 ? value : DEFAULT_PORT;
}

/** Strip trailing slashes; fall back to the default if the result is empty. */
function parseBaseUrl(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_UPSTREAM_BASE_URL;
  const stripped = raw.trim().replace(/\/+$/, "");
  return stripped.length > 0 ? stripped : DEFAULT_UPSTREAM_BASE_URL;
}

/**
 * Builds the model matcher.
 *
 * - PATCHED_MODELS set (comma-separated, possibly empty segments): exact match
 *   against normalized IDs.
 * - PATCHED_MODELS set but empty after trimming (e.g. ",,"): falls back to the
 *   default regex — an explicit-but-empty list is almost certainly a mistake.
 * - Unset: /gemini/i so new Gemini drops (3.8-flash, 3.8-pro, ...) work out of
 *   the box.
 *
 * The returned predicate is total: any non-string input yields false.
 */
function buildShouldPatchModel(env: NodeJS.ProcessEnv): ProxyConfig["shouldPatchModel"] {
  const raw = env["PATCHED_MODELS"];
  if (raw !== undefined && raw.trim().length > 0) {
    const ids = new Set(
      raw
        .split(",")
        .map((segment) => normalizeModelId(segment.trim()))
        .filter((segment) => segment.length > 0),
    );
    if (ids.size > 0) {
      return (model?: unknown) => {
        if (typeof model !== "string") return false;
        const normalized = normalizeModelId(model);
        return normalized.length > 0 && ids.has(normalized);
      };
    }
  }
  return (model?: unknown) => typeof model === "string" && DEFAULT_MODEL_PATTERN.test(model);
}

/**
 * Pure config loader — pass a plain object in tests to stay fully isolated
 * from process.env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return {
    port: parsePort(env["PORT"]),
    host: (env["HOST"] ?? "").trim() || DEFAULT_HOST,
    upstreamBaseUrl: parseBaseUrl(env["UPSTREAM_BASE_URL"]),
    shouldPatchModel: buildShouldPatchModel(env),
    cacheMaxEntries: parsePositiveInt(env["CACHE_MAX_ENTRIES"], DEFAULT_CACHE_MAX_ENTRIES),
    cacheTtlMs: parsePositiveInt(env["CACHE_TTL_MS"], DEFAULT_CACHE_TTL_MS),
  };
}
