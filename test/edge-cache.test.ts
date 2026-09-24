import { describe, expect, it } from "vitest";
import { EdgeCache, type EdgeRequest, type UpstreamResponse } from "../proxy/edge-cache.ts";

const ISR = "s-maxage=30, stale-while-revalidate=270";

function ok(body: string, cc = ISR, extra: Record<string, string> = {}): UpstreamResponse {
  return { status: 200, headers: { "cache-control": cc, ...extra }, body: Buffer.from(body) };
}

/** Upstream whose responses are released manually, so concurrency can be asserted. */
function controlledUpstream() {
  const calls: { req: EdgeRequest; resolve: (r: UpstreamResponse) => void; reject: (e: Error) => void }[] = [];
  const upstream = (req: EdgeRequest) =>
    new Promise<UpstreamResponse>((resolve, reject) => {
      calls.push({ req, resolve, reject });
    });
  return { upstream, calls };
}

const get = (url: string, headers: EdgeRequest["headers"] = {}): EdgeRequest => ({ method: "GET", url, headers });
const flush = () => new Promise((r) => setImmediate(r));

function setup(opts: Partial<ConstructorParameters<typeof EdgeCache>[0]> = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const up = controlledUpstream();
  const cache = new EdgeCache({ upstream: up.upstream, now: clock.now, ...opts });
  return { cache, clock, up };
}

describe("EdgeCache single-flight", () => {
  it("coalesces concurrent misses into one upstream request", async () => {
    const { cache, up } = setup();
    const pending = Array.from({ length: 50 }, () => cache.handle(get("/news/a")));
    await flush();
    expect(up.calls).toHaveLength(1);
    up.calls[0]!.resolve(ok("v1"));
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.outcome === "MISS")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "COALESCED")).toHaveLength(49);
    expect(results.every((r) => r.res.body.toString() === "v1")).toBe(true);
    expect(cache.stats()).toMatchObject({ upstreamFetches: 1, miss: 1, coalesced: 49, requests: 50, inflight: 0 });
  });

  it("coalesces across equivalent keys but not across RSC variants", async () => {
    const { cache, up } = setup();
    const a = cache.handle(get("/news/a?utm_source=x"));
    const b = cache.handle(get("/news/a/"));
    const c = cache.handle(get("/news/a", { rsc: "1" }));
    await flush();
    expect(up.calls).toHaveLength(2);
    up.calls[0]!.resolve(ok("html"));
    up.calls[1]!.resolve(ok("flight"));
    expect((await a).res.body.toString()).toBe("html");
    expect((await b).outcome).toBe("COALESCED");
    expect((await c).res.body.toString()).toBe("flight");
  });

  it("does not share uncacheable responses: followers refetch and the URL goes hit-for-pass", async () => {
    const { cache, up, clock } = setup({ hitForPassMs: 5_000 });
    const lead = cache.handle(get("/live/a"));
    const follow = cache.handle(get("/live/a"));
    await flush();
    expect(up.calls).toHaveLength(1);
    up.calls[0]!.resolve(ok("private-1", "private, no-store"));
    expect((await lead).outcome).toBe("MISS");
    await flush();
    expect(up.calls).toHaveLength(2); // follower fetched its own copy
    up.calls[1]!.resolve(ok("private-2", "private, no-store"));
    expect((await follow).outcome).toBe("PASS");

    const pass = cache.handle(get("/live/a"));
    await flush();
    up.calls[2]!.resolve(ok("private-3", "private, no-store"));
    expect((await pass).outcome).toBe("PASS");

    clock.advance(5_001);
    const again = cache.handle(get("/live/a"));
    await flush();
    up.calls[3]!.resolve(ok("private-4", "private, no-store"));
    expect((await again).outcome).toBe("MISS");
  });
});

describe("EdgeCache TTL and stale-while-revalidate", () => {
  it("serves HIT within s-maxage, then STALE with one background refresh", async () => {
    const { cache, up, clock } = setup({ maxSwrMs: 60_000 });
    const first = cache.handle(get("/news/a"));
    await flush();
    up.calls[0]!.resolve(ok("v1"));
    expect((await first).outcome).toBe("MISS");

    clock.advance(29_000);
    const hit = await cache.handle(get("/news/a"));
    expect(hit).toMatchObject({ outcome: "HIT", ageSec: 29 });

    clock.advance(2_000); // 31 s: stale, inside SWR
    const stale = await Promise.all([cache.handle(get("/news/a")), cache.handle(get("/news/a"))]);
    expect(stale.map((r) => r.outcome)).toEqual(["STALE", "STALE"]);
    expect(stale[0]!.res.body.toString()).toBe("v1");
    expect(up.calls).toHaveLength(2); // exactly one background revalidation
    expect(cache.stats().backgroundRevalidations).toBe(1);

    up.calls[1]!.resolve(ok("v2"));
    await flush();
    const fresh = await cache.handle(get("/news/a"));
    expect(fresh).toMatchObject({ outcome: "HIT", ageSec: 0 });
    expect(fresh.res.body.toString()).toBe("v2");
  });

  it("caps SWR and blocks once the window is over", async () => {
    const { cache, up, clock } = setup({ maxSwrMs: 10_000 });
    const first = cache.handle(get("/news/a"));
    await flush();
    up.calls[0]!.resolve(ok("v1"));
    await first;
    clock.advance(30_000 + 10_001);
    const blocked = cache.handle(get("/news/a"));
    await flush();
    expect(up.calls).toHaveLength(2);
    up.calls[1]!.resolve(ok("v2"));
    expect((await blocked).outcome).toBe("MISS");
  });

  it("keeps the stale copy when background revalidation fails", async () => {
    const { cache, up, clock } = setup();
    const first = cache.handle(get("/news/a"));
    await flush();
    up.calls[0]!.resolve(ok("v1"));
    await first;
    clock.advance(31_000);
    expect((await cache.handle(get("/news/a"))).outcome).toBe("STALE");
    up.calls[1]!.reject(new Error("boom"));
    await flush();
    const after = await cache.handle(get("/news/a"));
    expect(after.outcome).toBe("STALE");
    expect(after.res.body.toString()).toBe("v1");
    expect(cache.stats().upstreamErrors).toBe(1);
  });
});

describe("EdgeCache errors", () => {
  it("serves stale-if-error when the origin fails after SWR ran out", async () => {
    const { cache, up, clock } = setup({ maxSwrMs: 0, defaultSieMs: 120_000 });
    const first = cache.handle(get("/news/a"));
    await flush();
    up.calls[0]!.resolve(ok("v1"));
    await first;
    clock.advance(60_000);
    const r = cache.handle(get("/news/a"));
    await flush();
    up.calls[1]!.resolve({ status: 503, headers: {}, body: Buffer.from("down") });
    expect(await r).toMatchObject({ outcome: "STALE-IF-ERROR", ageSec: 60 });

    const r2 = cache.handle(get("/news/a"));
    await flush();
    up.calls[2]!.reject(new Error("ECONNREFUSED"));
    expect((await r2).res.body.toString()).toBe("v1");
  });

  it("returns ERROR (502) with nothing cached", async () => {
    const { cache, up } = setup();
    const r = cache.handle(get("/news/a"));
    await flush();
    up.calls[0]!.reject(new Error("ECONNREFUSED"));
    const res = await r;
    expect(res.outcome).toBe("ERROR");
    expect(res.res.status).toBe(502);

    const r2 = cache.handle(get("/news/b"));
    await flush();
    up.calls[1]!.resolve({ status: 500, headers: {}, body: Buffer.from("x") });
    expect((await r2).res.status).toBe(500);
    expect(cache.stats().errors).toBe(2);
  });
});

describe("EdgeCache bypass, purge, LRU", () => {
  it("bypasses non-GET, authorization and session cookies", async () => {
    const { cache, up } = setup();
    const reqs = [
      { method: "POST", url: "/api/publish", headers: {} },
      get("/news/a", { authorization: "Bearer x" }),
      get("/news/a", { cookie: "theme=dark; __session=abc" }),
    ];
    const pending = reqs.map((r) => cache.handle(r));
    await flush();
    expect(up.calls).toHaveLength(3);
    up.calls.forEach((c) => c.resolve(ok("x")));
    expect((await Promise.all(pending)).map((r) => r.outcome)).toEqual(["BYPASS", "BYPASS", "BYPASS"]);
    expect(cache.stats().entries).toBe(0);
  });

  it("reports upstream failure on a direct fetch as 502", async () => {
    const { cache, up } = setup();
    const r = cache.handle({ method: "DELETE", url: "/x", headers: {} });
    await flush();
    up.calls[0]!.reject(new Error("nope"));
    expect((await r).res.status).toBe(502);
  });

  it("hard purge removes every variant; soft purge makes it stale", async () => {
    const { cache, up } = setup();
    const warm = [
      cache.handle(get("/news/a")),
      cache.handle(get("/news/a", { rsc: "1" })),
      cache.handle(get("/news/b")),
    ];
    await flush();
    up.calls.forEach((c, i) => c.resolve(ok(`v${i}`)));
    await Promise.all(warm);
    expect(cache.purge(["/news/a/"], "hard")).toBe(2);
    expect(cache.stats().entries).toBe(1);

    expect(cache.purge(["/news/b"], "soft")).toBe(1);
    expect((await cache.handle(get("/news/b"))).outcome).toBe("STALE");
    expect(cache.stats().purged).toBe(3);
  });

  it("purge clears hit-for-pass markers", async () => {
    const { cache, up } = setup();
    const r = cache.handle(get("/live/a"));
    await flush();
    up.calls[0]!.resolve(ok("x", "no-store"));
    await r;
    cache.purge(["/live/a"]);
    const r2 = cache.handle(get("/live/a"));
    await flush();
    up.calls[1]!.resolve(ok("y"));
    expect((await r2).outcome).toBe("MISS");
  });

  it("evicts least recently used entries beyond maxEntries", async () => {
    const { cache, up } = setup({ maxEntries: 2 });
    for (const p of ["/a", "/b"]) {
      const r = cache.handle(get(p));
      await flush();
      up.calls.at(-1)!.resolve(ok(p));
      await r;
    }
    expect((await cache.handle(get("/a"))).outcome).toBe("HIT"); // /a now most recent
    const r = cache.handle(get("/c"));
    await flush();
    up.calls.at(-1)!.resolve(ok("/c"));
    await r;
    expect(cache.stats()).toMatchObject({ entries: 2, evicted: 1 });
    expect((await cache.handle(get("/a"))).outcome).toBe("HIT");
    const b = cache.handle(get("/b"));
    await flush();
    up.calls.at(-1)!.resolve(ok("/b"));
    expect((await b).outcome).toBe("MISS");
  });

  it("resets stats", async () => {
    const { cache, up } = setup();
    const r = cache.handle({ method: "POST", url: "/", headers: {} });
    await flush();
    up.calls[0]!.resolve(ok("x"));
    await r;
    expect(cache.stats().requests).toBe(1);
    cache.resetStats();
    expect(cache.stats().requests).toBe(0);
  });
});
