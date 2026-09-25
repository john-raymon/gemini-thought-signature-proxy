import { randomUUID } from 'node:crypto';

/** SSE comment frame written between real chunks while awaiting upstream. */
export const HEARTBEAT_FRAME = ': heartbeat\n\n';

/** Default delay between heartbeat frames while awaiting upstream headers. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;

/** Lowest heartbeat interval we honor — below this the interval pegs the event loop. */
export const MIN_HEARTBEAT_INTERVAL_MS = 500;

/**
 * Resolve the heartbeat interval from SSE_HEARTBEAT_INTERVAL_MS, falling back to
 * the default when unset, unparseable, or dangerously small.
 */
export function getHeartbeatIntervalMs(): number {
  const raw = process.env.SSE_HEARTBEAT_INTERVAL_MS;
  if (!raw) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const parsed = Math.floor(Number(raw));
  return Number.isFinite(parsed) && parsed >= MIN_HEARTBEAT_INTERVAL_MS
    ? parsed
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

/**
 * Synthetic first SSE data frame, written immediately after flushing headers so a
 * client's first-chunk timer resets before the real upstream bytes arrive. The
 * payload mirrors OpenAI's chunk-0 convention: role-only delta, no content.
 */
export function makeBootFrame(model?: unknown): string {
  const resolvedModel =
    typeof model === 'string' && model.trim() ? model.trim() : 'unknown';
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface SseErrorFrameInput {
  /** HTTP status the upstream returned (or 502 for proxy-level failures). */
  status: number;
  /** Raw upstream error body, or a proxy-generated description. */
  bodyText: string;
  /** Upstream retry-after header value, if any. */
  retryAfter?: string | null;
}

interface GoogleErrorShape {
  error: {
    message: string;
    code?: unknown;
    status?: unknown;
  };
}

function isGoogleError(parsed: unknown): parsed is GoogleErrorShape {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const err = (parsed as Record<string, unknown>).error;
  return (
    typeof err === 'object' &&
    err !== null &&
    !Array.isArray(err) &&
    typeof (err as Record<string, unknown>).message === 'string'
  );
}

/** Max raw-body characters embedded in an error frame. */
export const MAX_ERROR_BODY_CHARS = 500;

/**
 * OpenAI-shaped SSE error frame for stream:true requests whose headers were
 * already flushed optimistically, so the real HTTP status can no longer be sent.
 * Preserves Google's nested error message when present; otherwise embeds a
 * truncated raw body. Never followed by a [DONE] frame.
 */
export function makeSseErrorFrame(input: SseErrorFrameInput): string {
  const trimmedBody = input.bodyText.trim();
  let message: string | undefined;

  try {
    const parsed: unknown = JSON.parse(trimmedBody);
    if (isGoogleError(parsed)) {
      const rawCode = parsed.error.code;
      const code =
        typeof rawCode === 'number' || typeof rawCode === 'string'
          ? rawCode
          : input.status;
      message = `[Google ${code}] ${parsed.error.message}`;
    }
  } catch {
    // Non-JSON payload — fall through to the raw-text fallback.
  }

  if (!message) {
    // Strip a trailing unpaired high surrogate so truncation can't leave
    // half of an emoji in the message text.
    const sanitizedSlice = trimmedBody
      .slice(0, MAX_ERROR_BODY_CHARS)
      .replace(/[\uD800-\uDBFF]$/, '');
    message = sanitizedSlice || `Upstream error ${input.status}`;
  }

  const errorObj: Record<string, unknown> = {
    message,
    type: 'upstream_error',
    code: input.status,
  };

  if (input.retryAfter) {
    errorObj.retryAfter = input.retryAfter;
  }

  return `data: ${JSON.stringify({ error: errorObj })}\n\n`;
}
