import { describe, expect, it } from "vitest";
import { freshnessFor, parseCacheControl } from "../proxy/cache-control.ts";

const policy = { maxSwrMs: 60_000, defaultSieMs: 300_000 };

describe("Cache-Control", () => {
  it("parses directives", () => {
    expect(
      parseCacheControl('public, s-maxage=30, max-age="5", stale-while-revalidate=270, stale-if-error=10'),
    ).toEqual({
      sMaxAge: 30,
      maxAge: 5,
      staleWhileRevalidate: 270,
      staleIfError: 10,
      noStore: false,
      noCache: false,
      private: false,
    });
    expect(parseCacheControl(undefined)).toEqual({ noStore: false, noCache: false, private: false });
    expect(parseCacheControl("max-age=abc").maxAge).toBeUndefined();
  });

  it("uses s-maxage over max-age and caps SWR", () => {
    expect(
      freshnessFor(200, { "cache-control": "max-age=5, s-maxage=30, stale-while-revalidate=270" }, policy),
    ).toEqual({
      ttlMs: 30_000,
      swrMs: 60_000,
      sieMs: 300_000,
    });
    expect(freshnessFor(200, { "cache-control": ["max-age=5", "stale-if-error=7"] }, policy)).toEqual({
      ttlMs: 5_000,
      swrMs: 0,
      sieMs: 7_000,
    });
  });

  it("refuses uncacheable responses", () => {
    const dyn = "private, no-cache, no-store, max-age=0, must-revalidate";
    expect(freshnessFor(200, { "cache-control": dyn }, policy)).toBeNull();
    expect(freshnessFor(200, { "cache-control": "no-cache, s-maxage=10" }, policy)).toBeNull();
    expect(freshnessFor(200, {}, policy)).toBeNull();
    expect(freshnessFor(200, { "cache-control": "s-maxage=0" }, policy)).toBeNull();
    expect(freshnessFor(500, { "cache-control": "s-maxage=10" }, policy)).toBeNull();
    expect(freshnessFor(200, { "cache-control": "s-maxage=10", "set-cookie": "a=b" }, policy)).toBeNull();
    expect(freshnessFor(404, { "cache-control": "s-maxage=10" }, policy)?.ttlMs).toBe(10_000);
  });
});
