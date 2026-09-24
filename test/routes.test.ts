import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

import { POST as reset } from "../app/api/admin/reset/route";
import { POST as publish } from "../app/api/publish/route";
import { DELETE as resetStats, GET as stats } from "../app/api/stats/route";
import { GET as story } from "../app/api/stories/[slug]/route";
import { checkLabSecret } from "../lib/lab-auth";
import { purgeEdge } from "../lib/purge";
import { freshLab } from "./helpers";

const SECRET = "test-secret";

function req(body: unknown, headers: Record<string, string> = { "x-lab-secret": SECRET }): Request {
  return new Request("http://lab/api/publish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let lab: ReturnType<typeof freshLab>;
beforeEach(() => {
  lab = freshLab();
  process.env.LAB_SECRET = SECRET;
  delete process.env.CDN_PURGE_URL;
  revalidatePath.mockReset();
  vi.unstubAllGlobals();
});

describe("POST /api/publish (on-demand revalidation)", () => {
  it("updates the story and revalidates the article and home page", async () => {
    const res = await publish(req({ slug: "election-results-live", headline: "Result declared" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      story: { rev: number; headline: string };
      revalidated: string[];
      purge: unknown;
    };
    expect(json.story).toMatchObject({ rev: 2, headline: "Result declared" });
    expect(json.revalidated).toEqual(["/news/election-results-live", "/"]);
    expect(revalidatePath.mock.calls).toEqual([["/news/election-results-live"], ["/"]]);
    expect(json.purge).toEqual({ attempted: false });
  });

  it("purges the edge when CDN_PURGE_URL is set", async () => {
    process.env.CDN_PURGE_URL = "http://edge/__edge/purge";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await publish(req({ slug: "election-results-live", body: ["p1"] }));
    const json = (await res.json()) as { purge: unknown };
    expect(json.purge).toEqual({ attempted: true, ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://edge/__edge/purge");
    expect(JSON.parse(init.body as string)).toEqual({ paths: ["/news/election-results-live", "/"] });
    expect((init.headers as Record<string, string>)["x-lab-secret"]).toBe(SECRET);
  });

  it("rejects bad auth", async () => {
    expect((await publish(req({ slug: "a" }, {}))).status).toBe(401);
    expect((await publish(req({ slug: "a" }, { "x-lab-secret": "wrong-secre" }))).status).toBe(401);
    delete process.env.LAB_SECRET;
    expect((await publish(req({ slug: "a" }))).status).toBe(503);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["not json", "{"],
    ["not an object", "null"],
    ["bad slug", { slug: "Bad Slug" }],
    ["bad headline", { slug: "a", headline: 5 }],
    ["long summary", { slug: "a", summary: "x".repeat(501) }],
    ["bad body", { slug: "a", body: [1] }],
    ["new story without headline", { slug: "brand-new-story" }],
  ])("returns 400 for %s", async (_name, body) => {
    const res = await publish(req(body));
    expect(res.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns 503 when the origin is overloaded", async () => {
    const { Origin, setOrigin } = await import("../lib/origin");
    const o = new Origin({ latencyMs: 200, maxConcurrency: 1, queueTimeoutMs: 10 });
    setOrigin(o);
    const busy = o.query("read", async () => null);
    const res = await publish(req({ slug: "election-results-live", headline: "x" }));
    expect(res.status).toBe(503);
    await busy;
  });
});

describe("admin + stats routes", () => {
  it("reports and resets origin stats", async () => {
    await publish(req({ slug: "election-results-live", headline: "x" }));
    await new Promise((r) => setTimeout(r, 30)); // let the loop-lag histogram sample
    const s = (await stats().json()) as { origin: { writes: number }; loopLag: { p99Ms: number } };
    expect(s.origin.writes).toBe(1);
    expect(s.loopLag.p99Ms).toBeGreaterThanOrEqual(0);
    expect(resetStats(new Request("http://lab/api/stats", { method: "DELETE" })).status).toBe(401);
    const ok = resetStats(
      new Request("http://lab/api/stats", { method: "DELETE", headers: { "x-lab-secret": SECRET } }),
    );
    expect(ok.status).toBe(200);
    expect(lab.origin.snapshot().writes).toBe(0);
    const { loopLag } = await import("../lib/loop-lag");
    expect(loopLag()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  it("resets the store and revalidates everything", async () => {
    await publish(req({ slug: "election-results-live", headline: "x" }));
    revalidatePath.mockReset();
    expect((await reset(new Request("http://lab/x", { method: "POST" }))).status).toBe(401);
    const res = await reset(new Request("http://lab/x", { method: "POST", headers: { "x-lab-secret": SECRET } }));
    expect(res.status).toBe(200);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    const s = await story(new Request("http://lab/api/stories/election-results-live"), {
      params: Promise.resolve({ slug: "election-results-live" }),
    });
    expect(((await s.json()) as { rev: number }).rev).toBe(1);
    const missing = await story(new Request("http://lab/x"), { params: Promise.resolve({ slug: "nope" }) });
    expect(missing.status).toBe(404);
  });
});

describe("helpers", () => {
  it("checkLabSecret", () => {
    const r = new Request("http://x", { headers: { "x-lab-secret": "abc" } });
    expect(checkLabSecret(r, { LAB_SECRET: "abc" })).toEqual({ ok: true });
    expect(checkLabSecret(r, { LAB_SECRET: "abd" }).ok).toBe(false);
    expect(checkLabSecret(r, {})).toMatchObject({ ok: false, status: 503 });
  });

  it("purgeEdge reports failures instead of throwing", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await purgeEdge(["/"], { CDN_PURGE_URL: "http://edge" }, failing as unknown as typeof fetch)).toEqual({
      attempted: true,
      ok: false,
      error: "ECONNREFUSED",
    });
  });
});
