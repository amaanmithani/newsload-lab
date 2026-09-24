import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EdgeCache } from "../proxy/edge-cache.ts";
import { createEdgeServer, httpUpstream } from "../proxy/server.ts";

let originHits = 0;
let originUrl = "";
let edgeUrl = "";
const servers: http.Server[] = [];
let agent: http.Agent;

function listen(s: http.Server): Promise<string> {
  servers.push(s);
  return new Promise((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)),
  );
}

beforeAll(async () => {
  originUrl = await listen(
    http.createServer((req, res) => {
      originHits++;
      if (req.url?.startsWith("/slow")) {
        setTimeout(() => {
          res.writeHead(200, { "cache-control": "s-maxage=30", "content-type": "text/plain" });
          res.end(`slow ${req.headers["accept-encoding"]} ${req.headers["x-forwarded-by"]}`);
        }, 50);
        return;
      }
      if (req.url?.startsWith("/dynamic")) {
        res.writeHead(200, { "cache-control": "private, no-store", connection: "keep-alive" });
        res.end("dyn");
        return;
      }
      res.writeHead(404, { "cache-control": "no-store" });
      res.end("nope");
    }),
  );
  const up = httpUpstream({ origin: originUrl, timeoutMs: 2000 });
  agent = up.agent;
  const cache = new EdgeCache({ upstream: up.upstream });
  edgeUrl = await listen(createEdgeServer({ cache, secret: "s3", purgeMode: "hard" }));
});

afterAll(async () => {
  agent.destroy();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe("edge server over HTTP", () => {
  it("coalesces 20 concurrent requests into one origin hit and sets headers", async () => {
    originHits = 0;
    const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${edgeUrl}/slow/a`)));
    expect(originHits).toBe(1);
    const outcomes = responses.map((r) => r.headers.get("x-cache")).sort();
    expect(outcomes.filter((o) => o === "MISS")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "COALESCED")).toHaveLength(19);
    expect(await responses[0]!.text()).toBe("slow identity newsload-edge");
    const hit = await fetch(`${edgeUrl}/slow/a?utm_source=push`);
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(hit.headers.get("age")).toBe("0");
    expect(originHits).toBe(1);
  });

  it("answers HEAD without a body and passes dynamic pages through", async () => {
    const head = await fetch(`${edgeUrl}/slow/a`, { method: "HEAD" });
    expect(head.headers.get("x-cache")).toBe("HIT");
    expect(await head.text()).toBe("");
    const dyn = await fetch(`${edgeUrl}/dynamic/x`);
    expect(dyn.headers.get("x-cache")).toBe("MISS");
    expect((await fetch(`${edgeUrl}/dynamic/x`)).headers.get("x-cache")).toBe("PASS");
  });

  it("rejects writes", async () => {
    expect((await fetch(`${edgeUrl}/api/publish`, { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("serves admin endpoints", async () => {
    expect((await (await fetch(`${edgeUrl}/__edge/health`)).json()) as unknown).toEqual({ ok: true });
    const stats = (await (await fetch(`${edgeUrl}/__edge/stats`)).json()) as { requests: number };
    expect(stats.requests).toBeGreaterThan(0);
    expect((await fetch(`${edgeUrl}/__edge/stats`, { method: "DELETE" })).status).toBe(401);
    const del = await fetch(`${edgeUrl}/__edge/stats`, { method: "DELETE", headers: { "x-lab-secret": "s3" } });
    expect(del.status).toBe(200);

    const purge = await fetch(`${edgeUrl}/__edge/purge`, {
      method: "POST",
      headers: { "x-lab-secret": "s3" },
      body: JSON.stringify({ paths: ["/slow/a"] }),
    });
    expect(await purge.json()).toEqual({ purged: 1, mode: "hard" });
    const soft = await fetch(`${edgeUrl}/__edge/purge`, {
      method: "POST",
      headers: { "x-lab-secret": "s3" },
      body: JSON.stringify({ paths: ["/slow/a"], mode: "soft" }),
    });
    expect(await soft.json()).toEqual({ purged: 0, mode: "soft" });

    const badJson = await fetch(`${edgeUrl}/__edge/purge`, {
      method: "POST",
      headers: { "x-lab-secret": "s3" },
      body: "{",
    });
    expect(badJson.status).toBe(400);
    const badPaths = await fetch(`${edgeUrl}/__edge/purge`, {
      method: "POST",
      headers: { "x-lab-secret": "s3" },
      body: JSON.stringify({ paths: ["relative"] }),
    });
    expect(badPaths.status).toBe(400);
    expect((await fetch(`${edgeUrl}/__edge/nope`, { headers: { "x-lab-secret": "s3" } })).status).toBe(404);
  });

  it("returns 502 when the origin is unreachable", async () => {
    const up = httpUpstream({ origin: "http://127.0.0.1:1", timeoutMs: 500 });
    const s = createEdgeServer({ cache: new EdgeCache({ upstream: up.upstream }) });
    const url = await listen(s);
    const res = await fetch(`${url}/x`);
    expect(res.status).toBe(502);
    expect(res.headers.get("x-cache")).toBe("ERROR");
    expect((await fetch(`${url}/__edge/stats`, { method: "DELETE" })).status).toBe(503);
    up.agent.destroy();
  });
});
