import { afterEach, describe, expect, it, vi } from "vitest";
import { SignatureCache } from "../src/cache.js";

function makeCache(overrides?: Partial<ConstructorParameters<typeof SignatureCache>[0]>) {
  return new SignatureCache({
    maxEntries: 5000,
    ttlMs: 60_000,
    sweepIntervalMs: null, // no background timers in unit tests
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SignatureCache basic get/set", () => {
  it("returns miss for unknown ids", () => {
    const cache = makeCache();
    expect(cache.get("nope")).toEqual({ state: "miss" });
    expect(cache.size).toBe(0);
  });

  it("stores and returns a signed string", () => {
    const cache = makeCache();
    cache.set("call_a", "sigA");
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sigA" });
  });

  it("stores and returns unsigned null", () => {
    const cache = makeCache();
    cache.set("call_b", null);
    expect(cache.get("call_b")).toEqual({ state: "unsigned" });
  });
});

describe("SignatureCache upgrade/downgrade rules", () => {
  it("upgrades null to string", () => {
    const cache = makeCache();
    cache.set("call_a", null);
    cache.set("call_a", "sig");
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sig" });
  });

  it("never downgrades a string to null", () => {
    const cache = makeCache();
    cache.set("call_a", "sig");
    cache.set("call_a", null);
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sig" });
  });

  it("overwrites string with a newer string", () => {
    const cache = makeCache();
    cache.set("call_a", "sig1");
    cache.set("call_a", "sig2");
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sig2" });
  });

  it("normalizes empty and whitespace-only strings to unsigned", () => {
    const cache = makeCache();
    cache.set("call_a", "");
    expect(cache.get("call_a")).toEqual({ state: "unsigned" });
    cache.set("call_b", "   \n\t ");
    expect(cache.get("call_b")).toEqual({ state: "unsigned" });
  });

  it("whitespace input does not clobber an existing signature", () => {
    const cache = makeCache();
    cache.set("call_a", "sig");
    cache.set("call_a", "   ");
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sig" });
  });

  it("trims stored signatures (base64-safe)", () => {
    const cache = makeCache();
    cache.set("call_a", "  sigPadded  ");
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sigPadded" });
  });
});

describe("SignatureCache TTL", () => {
  it("expires entries lazily on read", () => {
    let nowMs = 1_000;
    const cache = makeCache({ ttlMs: 1_000, now: () => nowMs });
    cache.set("call_a", "sig");
    nowMs = 2_500;
    expect(cache.get("call_a")).toEqual({ state: "miss" });
    expect(cache.size).toBe(0);
  });

  it("refreshes TTL on re-set of an existing key", () => {
    let nowMs = 0;
    const cache = makeCache({ ttlMs: 1_000, now: () => nowMs });
    cache.set("call_a", "sig");
    nowMs = 900;
    cache.set("call_a", "sig2");
    nowMs = 1_800; // past original expiry, within refreshed window
    expect(cache.get("call_a")).toEqual({ state: "signed", value: "sig2" });
  });

  it("does not extend TTL on read (LRU touch only)", () => {
    let nowMs = 0;
    const cache = makeCache({ ttlMs: 1_000, now: () => nowMs });
    cache.set("call_a", "sig");
    nowMs = 900;
    expect(cache.get("call_a").state).toBe("signed");
    nowMs = 1_100;
    expect(cache.get("call_a")).toEqual({ state: "miss" });
  });

  it("does not resurrect an expired signature via the downgrade guard", () => {
    let nowMs = 0;
    const cache = makeCache({ ttlMs: 1_000, now: () => nowMs });
    cache.set("call_a", "sigA");
    nowMs = 1_500; // expired, not yet swept
    cache.set("call_a", null);
    expect(cache.get("call_a")).toEqual({ state: "unsigned" });
  });
});


describe("SignatureCache LRU eviction", () => {
  it("evicts the least-recently-used key at capacity", () => {
    const cache = makeCache({ maxEntries: 3 });
    cache.set("A", "a");
    cache.set("B", "b");
    cache.set("C", "c");
    cache.get("A"); // touch A -> B is now oldest
    cache.set("D", "d");
    expect(cache.get("B")).toEqual({ state: "miss" });
    expect(cache.get("A").state).toBe("signed");
    expect(cache.get("C").state).toBe("signed");
    expect(cache.get("D").state).toBe("signed");
    expect(cache.size).toBe(3);
  });

  it("overwriting at capacity evicts nobody", () => {
    const cache = makeCache({ maxEntries: 3 });
    cache.set("A", "a");
    cache.set("B", "b");
    cache.set("C", "c");
    cache.set("B", "b2");
    expect(cache.size).toBe(3);
    expect(cache.get("A").state).toBe("signed");
    expect(cache.get("B")).toEqual({ state: "signed", value: "b2" });
    expect(cache.get("C").state).toBe("signed");
  });
});

describe("SignatureCache sweep/dispose", () => {
  it("sweep() removes expired entries and returns the count", () => {
    let nowMs = 0;
    const cache = makeCache({ ttlMs: 100, now: () => nowMs });
    cache.set("A", "a");
    cache.set("B", "b");
    nowMs = 150;
    cache.set("C", "c"); // fresh entry inside the new window
    expect(cache.sweep()).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.get("C").state).toBe("signed");
  });

  it("background interval sweeps automatically and dispose() stops it", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const cache = new SignatureCache({
      maxEntries: 10,
      ttlMs: 100,
      sweepIntervalMs: 50,
      now: () => nowMs,
    });
    cache.set("A", "a");
    nowMs = 200; // entry expired
    vi.advanceTimersByTime(60); // fire one sweep tick
    expect(cache.size).toBe(0);
    cache.dispose();
    cache.set("B", "b");
    nowMs = 1_000;
    vi.advanceTimersByTime(500);
    // Timer is gone: lazy map still holds B until read/sweep.
    expect(cache.size).toBe(1);
  });

  it("sweepIntervalMs: null creates no timer", () => {
    vi.useFakeTimers();
    const cache = makeCache();
    cache.set("A", "a");
    vi.advanceTimersByTime(10_000);
    expect(cache.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    cache.dispose();
  });
});


describe("SignatureCache constructor guards", () => {
  it("NaN maxEntries falls back instead of disabling eviction", () => {
    const cache = new SignatureCache({
      maxEntries: Number.NaN,
      ttlMs: 60_000,
      sweepIntervalMs: null,
    });
    for (let i = 0; i < 5010; i++) cache.set(`k${i}`, "v");
    expect(cache.size).toBeLessThanOrEqual(5000);
  });

  it("NaN ttlMs falls back to a finite TTL", () => {
    const cache = new SignatureCache({
      maxEntries: 10,
      ttlMs: Number.NaN,
      sweepIntervalMs: null,
    });
    cache.set("A", "a");
    expect(cache.get("A").state).toBe("signed");
  });
});
