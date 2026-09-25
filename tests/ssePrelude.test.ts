import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_FRAME,
  getHeartbeatIntervalMs,
  makeBootFrame,
  makeSseErrorFrame,
  MAX_ERROR_BODY_CHARS,
  MIN_HEARTBEAT_INTERVAL_MS,
} from '../src/ssePrelude.js';

/** Strip the SSE framing and parse the data payload as JSON. */
function parseFrame(frame: string): Record<string, unknown> {
  expect(frame.startsWith('data: ')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  const json = frame.slice('data: '.length, -2);
  expect(json.includes('\n')).toBe(false);
  return JSON.parse(json) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HEARTBEAT_FRAME', () => {
  it('is a single SSE comment frame', () => {
    expect(HEARTBEAT_FRAME).toBe(': heartbeat\n\n');
  });
});

describe('getHeartbeatIntervalMs', () => {
  it('returns the default when the env var is unset', () => {
    delete process.env.SSE_HEARTBEAT_INTERVAL_MS;
    expect(getHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  it('honors a valid interval', () => {
    vi.stubEnv('SSE_HEARTBEAT_INTERVAL_MS', '3000');
    expect(getHeartbeatIntervalMs()).toBe(3000);
    vi.stubEnv('SSE_HEARTBEAT_INTERVAL_MS', String(MIN_HEARTBEAT_INTERVAL_MS));
    expect(getHeartbeatIntervalMs()).toBe(MIN_HEARTBEAT_INTERVAL_MS);
  });

  it('rejects values below the minimum interval', () => {
    for (const raw of ['0', '100', '499', '-2000']) {
      vi.stubEnv('SSE_HEARTBEAT_INTERVAL_MS', raw);
      expect(getHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    }
  });

  it('rejects non-numeric values', () => {
    for (const raw of ['invalid', '   ']) {
      vi.stubEnv('SSE_HEARTBEAT_INTERVAL_MS', raw);
      expect(getHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    }
  });

  it('floors float values', () => {
    vi.stubEnv('SSE_HEARTBEAT_INTERVAL_MS', '2500.7');
    expect(getHeartbeatIntervalMs()).toBe(2500);
  });
});

describe('makeBootFrame', () => {
  it('emits a single-line SSE data frame terminating in a blank line', () => {
    const frame = makeBootFrame('gemini-x');
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    expect(frame.trim().split('\n')).toHaveLength(1);
  });

  it('carries a valid OpenAI chunk-0 payload with a role-only delta', () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = parseFrame(makeBootFrame('gemini-3.1-flash-preview'));
    const after = Math.floor(Date.now() / 1000);

    expect(payload.id).toMatch(/^chatcmpl-[0-9a-f-]{36}$/);
    expect(payload.object).toBe('chat.completion.chunk');
    expect(payload.created).toBeGreaterThanOrEqual(before);
    expect(payload.created).toBeLessThanOrEqual(after + 1);
    expect(payload.model).toBe('gemini-3.1-flash-preview');

    const choices = payload.choices as Array<Record<string, unknown>>;
    expect(choices).toHaveLength(1);
    expect(choices[0].index).toBe(0);
    expect(choices[0].finish_reason).toBeNull();
    expect(choices[0].delta).toStrictEqual({ role: 'assistant' });
  });

  it('generates a unique id on each call', () => {
    expect(makeBootFrame()).not.toBe(makeBootFrame());
  });

  it('escapes model quotes and newlines so the frame cannot be injected', () => {
    const model = 'foo"bar\ndata: {"injected":true}';
    const payload = parseFrame(makeBootFrame(model));
    expect(payload.model).toBe(model);
  });

  it('falls back to "unknown" for missing or non-string models', () => {
    for (const model of [undefined, '', '   ', 123, {}, null] as unknown[]) {
      expect(parseFrame(makeBootFrame(model)).model).toBe('unknown');
    }
  });

  it('trims surrounding whitespace from the model', () => {
    expect(parseFrame(makeBootFrame('  gemini-x  ')).model).toBe('gemini-x');
  });
});

describe('makeSseErrorFrame', () => {

  it('preserves the nested Google error code and message', () => {

    const payload = parseFrame(

      makeSseErrorFrame({

        status: 400,

        bodyText: JSON.stringify({

          error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' },

        }),

      })

    );

    const error = payload.error as Record<string, unknown>;

    expect(error.message).toBe('[Google 400] Request contains an invalid argument.');

    expect(error.type).toBe('upstream_error');

    expect(error.code).toBe(400);

  });

  it('falls back to the HTTP status when the Google error lacks a code', () => {

    const payload = parseFrame(

      makeSseErrorFrame({

        status: 429,

        bodyText: JSON.stringify({ error: { message: 'Quota exceeded.' } }),

      })

    );

    const error = payload.error as Record<string, unknown>;

    expect(error.message).toBe('[Google 429] Quota exceeded.');

  });

  it('ignores a non-scalar Google error code', () => {

    const payload = parseFrame(

      makeSseErrorFrame({

        status: 403,

        bodyText: JSON.stringify({ error: { code: { nested: true }, message: 'Forbidden.' } }),

      })

    );

    const error = payload.error as Record<string, unknown>;

    expect(error.message).toBe('[Google 403] Forbidden.');

  });

  it('treats non-object or null-error JSON as raw text', () => {

    for (const bodyText of ['"true"', '[1, 2, 3]', '{"error": null}', '{"error": "oops"}']) {

      const payload = parseFrame(makeSseErrorFrame({ status: 500, bodyText }));

      const error = payload.error as Record<string, unknown>;

      expect(error.message).toBe(bodyText);

    }

  });

  it('embeds a truncated raw text body for non-JSON errors', () => {

    const payload = parseFrame(

      makeSseErrorFrame({ status: 502, bodyText: 'Bad gateway: ' + 'x'.repeat(600) })

    );

    const error = payload.error as Record<string, unknown>;

    expect(error.message).toBe(('Bad gateway: ' + 'x'.repeat(600)).slice(0, MAX_ERROR_BODY_CHARS));

    expect((error.message as string).length).toBe(MAX_ERROR_BODY_CHARS);

  });

  it('never leaves a dangling high surrogate after truncation', () => {

    // Pad so the 500-char cut lands between the surrogate halves of the emoji.

    const bodyText = 'y'.repeat(MAX_ERROR_BODY_CHARS - 1) + '\u{1F600}';

    const payload = parseFrame(makeSseErrorFrame({ status: 500, bodyText }));

    const error = payload.error as Record<string, unknown>;

    const message = error.message as string;

    expect(message).not.toMatch(/[\uD800-\uDBFF]$/);

    expect(message).toBe('y'.repeat(MAX_ERROR_BODY_CHARS - 1));

  });

  it('falls back to a status-only message for empty or whitespace bodies', () => {

    for (const bodyText of ['', '   \n\t  ']) {

      const payload = parseFrame(makeSseErrorFrame({ status: 503, bodyText }));

      const error = payload.error as Record<string, unknown>;

      expect(error.message).toBe('Upstream error 503');

    }

  });

  it('includes retryAfter only when a non-empty value is provided', () => {

    const withRetry = parseFrame(

      makeSseErrorFrame({ status: 429, bodyText: 'rate limited', retryAfter: '30' })

    );

    expect((withRetry.error as Record<string, unknown>).retryAfter).toBe('30');

    for (const retryAfter of [null, undefined, ''] as Array<string | null | undefined>) {

      const payload = parseFrame(makeSseErrorFrame({ status: 429, bodyText: 'rate limited', retryAfter }));

      expect((payload.error as Record<string, unknown>).retryAfter).toBeUndefined();

    }

  });

  it('emits no [DONE] marker - just the single error frame', () => {

    const frame = makeSseErrorFrame({ status: 400, bodyText: 'bad' });

    expect(frame).not.toContain('[DONE]');

  });

});
