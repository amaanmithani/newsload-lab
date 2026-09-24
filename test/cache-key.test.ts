import { describe, expect, it } from "vitest";
import { cacheKey, normalizePath, normalizeQuery, variantOf } from "../proxy/cache-key.ts";

describe("cache key normalisation", () => {
  it("collapses duplicate slashes and drops trailing slash", () => {
    expect(normalizePath("//news///a/")).toBe("/news/a");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
  });

  it("drops tracking params and sorts the rest", () => {
    const q = new URLSearchParams("utm_source=tw&b=2&fbclid=x&a=1&gclid=y&a=0&_rsc=abc");
    expect(normalizeQuery(q)).toBe("a=0&a=1&b=2");
  });

  it("honours an allow-list", () => {
    expect(normalizeQuery(new URLSearchParams("page=2&sort=new&x=1"), { allowedQuery: ["page"] })).toBe("page=2");
  });

  it("maps equivalent URLs to one key", () => {
    const a = cacheKey("/news/story/?utm_campaign=push&b=1&a=2");
    const b = cacheKey("/news//story?a=2&b=1&fbclid=abc");
    expect(a).toEqual(b);
    expect(a).toEqual({ key: "/news/story?a=2&b=1#html", path: "/news/story" });
  });

  it("keeps RSC variants apart from HTML", () => {
    expect(variantOf({})).toBe("html");
    expect(variantOf({ rsc: "1" })).toBe("rsc");
    expect(variantOf({ rsc: ["1"], "next-router-prefetch": "1" })).toBe("rsc-prefetch");
    expect(variantOf({ rsc: "1", "next-router-segment-prefetch": "/_tree" })).toBe("rsc-seg:/_tree");
    expect(cacheKey("/a", { rsc: "1" }).key).not.toBe(cacheKey("/a").key);
  });

  it("accepts absolute URLs", () => {
    expect(cacheKey("http://example.com/x?b=1").key).toBe("/x?b=1#html");
  });
});
