import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_BASE_URL,
  loadConfig,
} from "../src/config.js";

describe("loadConfig defaults", () => {
  it("returns all defaults for an empty env", () => {
    const config = loadConfig({});
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
    expect(config.cacheMaxEntries).toBe(DEFAULT_CACHE_MAX_ENTRIES);
    expect(config.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS);
  });
});

describe("loadConfig env overrides", () => {
  it("honors a full valid env", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "0.0.0.0",
      UPSTREAM_BASE_URL: "http://localhost:9998",
      CACHE_MAX_ENTRIES: "100",
      CACHE_TTL_MS: "1000",
    });
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.upstreamBaseUrl).toBe("http://localhost:9998");
    expect(config.cacheMaxEntries).toBe(100);
    expect(config.cacheTtlMs).toBe(1000);
  });

  it("falls back to default host when HOST is blank", () => {
    expect(loadConfig({ HOST: "   " }).host).toBe(DEFAULT_HOST);
  });
});

describe("port parsing", () => {
  it("accepts boundary ports", () => {
    expect(loadConfig({ PORT: "1" }).port).toBe(1);
    expect(loadConfig({ PORT: "65535" }).port).toBe(65535);
  });

  it("rejects out-of-range and malformed ports", () => {
    for (const bad of ["0", "-1", "70000", "abc", "3000.5", "3000px", ""]) {
      expect(loadConfig({ PORT: bad }).port).toBe(DEFAULT_PORT);
    }
  });
});

describe("cache numeric parsing", () => {
  it("rejects zero, negatives and non-integers", () => {
    for (const bad of ["0", "-5", "3.7", " NaN ", "1e3"]) {
      expect(loadConfig({ CACHE_MAX_ENTRIES: bad }).cacheMaxEntries).toBe(DEFAULT_CACHE_MAX_ENTRIES);
      expect(loadConfig({ CACHE_TTL_MS: bad }).cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS);
    }
  });
});

describe("upstream base URL parsing", () => {
  it("strips trailing slashes", () => {
    expect(loadConfig({ UPSTREAM_BASE_URL: "https://example.com/" }).upstreamBaseUrl).toBe(
      "https://example.com",
    );
    expect(loadConfig({ UPSTREAM_BASE_URL: "https://example.com///" }).upstreamBaseUrl).toBe(
      "https://example.com",
    );
  });

  it("falls back to default when empty or slashes-only", () => {
    expect(loadConfig({ UPSTREAM_BASE_URL: "" }).upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
    expect(loadConfig({ UPSTREAM_BASE_URL: "///" }).upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
  });
});

describe("shouldPatchModel: default regex matcher", () => {
  const matcher = loadConfig({}).shouldPatchModel;

  it("matches gemini model IDs case-insensitively, with or without models/ prefix", () => {
    expect(matcher("models/gemini-3.8-flash")).toBe(true);
    expect(matcher("gemini-2.0-flash-exp")).toBe(true);
    expect(matcher("GEMINI-3.1-PRO-PREVIEW")).toBe(true);
  });

  it("rejects non-gemini models", () => {
    expect(matcher("gpt-4o")).toBe(false);
    expect(matcher("claude-3-5-sonnet")).toBe(false);
  });

  it("never throws on junk input", () => {
    expect(matcher(undefined)).toBe(false);
    expect(matcher(null)).toBe(false);
    expect(matcher("")).toBe(false);
    expect(matcher(123)).toBe(false);
  });
});

describe("shouldPatchModel: PATCHED_MODELS csv matcher", () => {
  it("exact-matches listed IDs and ignores whitespace/empty segments", () => {
    const matcher = loadConfig({
      PATCHED_MODELS: " gemini-3.8-flash ,, gemini-3.1-pro ,",
    }).shouldPatchModel;
    expect(matcher("gemini-3.8-flash")).toBe(true);
    expect(matcher("gemini-3.1-pro")).toBe(true);
    expect(matcher("gemini-2.0-flash")).toBe(false);
    expect(matcher("gpt-4o")).toBe(false);
  });

  it("normalizes the models/ prefix in both directions", () => {
    const matcher = loadConfig({ PATCHED_MODELS: "gemini-3.8-flash" }).shouldPatchModel;
    expect(matcher("models/gemini-3.8-flash")).toBe(true);

    const prefixMatcher = loadConfig({ PATCHED_MODELS: "models/gemini-3.8-flash" }).shouldPatchModel;
    expect(prefixMatcher("gemini-3.8-flash")).toBe(true);
  });

  it("tolerates padded model IDs from clients", () => {
    const matcher = loadConfig({ PATCHED_MODELS: "gemini-3.8-flash" }).shouldPatchModel;
    expect(matcher("  models/gemini-3.8-flash ")).toBe(true);
  });

  it("falls back to the regex when the csv is effectively empty", () => {
    const matcher = loadConfig({ PATCHED_MODELS: " , ,, " }).shouldPatchModel;
    expect(matcher("gemini-3.8-flash")).toBe(true);
    expect(matcher("gpt-4o")).toBe(false);
  });

  it("never throws on junk input", () => {
    const matcher = loadConfig({ PATCHED_MODELS: "gemini-3.8-flash" }).shouldPatchModel;
    expect(matcher(undefined)).toBe(false);
    expect(matcher(null)).toBe(false);
    expect(matcher(123)).toBe(false);
  });
});
