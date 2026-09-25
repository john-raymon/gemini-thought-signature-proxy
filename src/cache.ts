import type { CacheEntry, CacheLookup } from "./types.js";

interface CacheRecord {
  value: CacheEntry;
  expiresAt: number;
}

export interface SignatureCacheOptions {
  maxEntries: number;
  ttlMs: number;
  /**
   * Background sweep cadence. Defaults to min(ttlMs, 60s).
   * Pass null (or <= 0) to disable the timer entirely — recommended in tests.
   */
  sweepIntervalMs?: number | null;
  /** Injectable clock for deterministic TTL tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Whitespace is never part of a valid thought signature (base64 protobuf
 * token). Trim for fidelity AND validity: pure-whitespace input degrades to
 * null ("known unsigned"), which — combined with the no-downgrade rule —
 * means set(id, '') can never clobber a real signature.
 */
function normalizeValue(value: CacheEntry): CacheEntry {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

/**
 * In-memory tool_call.id -> thought_signature store.
 *
 * Three states: signed (string), unsigned (null = known parallel sibling),
 * miss (absent — caller decides on the bypass sentinel). Keys are tool-call
 * IDs only: no message content, no API keys. LRU-ordered Map, fixed TTL with
 * an unref'd background sweep; sweep() and dispose() are public for tests
 * and clean shutdown.
 */
export class SignatureCache {
  private readonly map = new Map<string, CacheRecord>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SignatureCacheOptions) {
    // Math.max(1, Math.floor(NaN)) is NaN — an invalid option must not
    // silently disable eviction (size > NaN is always false). Guard first.
    this.maxEntries = Number.isFinite(options.maxEntries)
      ? Math.max(1, Math.floor(options.maxEntries))
      : 5000;
    this.ttlMs = Number.isFinite(options.ttlMs)
      ? Math.max(1, Math.floor(options.ttlMs))
      : 3_600_000;
    this.now = options.now ?? Date.now;

    const sweepIntervalMs =
      options.sweepIntervalMs === undefined
        ? Math.min(this.ttlMs, 60_000)
        : options.sweepIntervalMs;

    if (sweepIntervalMs !== null && sweepIntervalMs > 0) {
      this.timer = setInterval(() => this.sweep(), sweepIntervalMs);
      // Edge runtimes return numeric timer IDs without unref().
      const t = this.timer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    }
  }

  get size(): number {
    return this.map.size;
  }

  get(id: string): CacheLookup {
    const record = this.map.get(id);
    if (record === undefined) return { state: "miss" };

    if (record.expiresAt <= this.now()) {
      this.map.delete(id);
      return { state: "miss" };
    }

    // LRU touch: move to Map tail. TTL is NOT extended on read.
    this.map.delete(id);
    this.map.set(id, record);

    return record.value === null
      ? { state: "unsigned" }
      : { state: "signed", value: record.value };
  }

  set(id: string, value: CacheEntry): void {
    const normalized = normalizeValue(value);
    const now = this.now();
    const existing = this.map.get(id);
    const existingValid = existing !== undefined && existing.expiresAt > now;

    if (existingValid && existing !== undefined) {
      // String never downgraded by null; null upgraded by string; same-type
      // overwrite wins. Expired entries are treated as absent (no zombie
      // resurrection via the downgrade guard).
      const finalValue =
        existing.value !== null && normalized === null ? existing.value : normalized;
      this.map.delete(id);
      this.map.set(id, { value: finalValue, expiresAt: now + this.ttlMs });
      return;
    }

    // Logically new key (absent or expired).
    if (existing !== undefined) this.map.delete(id);
    this.map.set(id, { value: normalized, expiresAt: now + this.ttlMs });

    // Evict LRU head only when a genuinely new key pushes past capacity.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Deletes all expired entries. Returns the number evicted. */
  sweep(): number {
    const now = this.now();
    let evicted = 0;
    for (const [id, record] of this.map) {
      if (record.expiresAt <= now) {
        this.map.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Stops the background sweep timer. Safe to call multiple times. */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
