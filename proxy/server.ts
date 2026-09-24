import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { EdgeCache, type EdgeRequest, type EdgeResult, type Upstream, type UpstreamResponse } from "./edge-cache.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export interface HttpUpstreamOptions {
  origin: string; // e.g. http://127.0.0.1:3000
  timeoutMs?: number;
  maxSockets?: number;
}

/** node:http upstream with a keep-alive pool. Asks for identity encoding so bodies can be cached as-is. */
export function httpUpstream(opts: HttpUpstreamOptions): { upstream: Upstream; agent: http.Agent } {
  const base = new URL(opts.origin);
  const agent = new http.Agent({ keepAlive: true, maxSockets: opts.maxSockets ?? 256 });
  const upstream: Upstream = (req) =>
    new Promise<UpstreamResponse>((resolve, reject) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k) && k !== "host" && k !== "accept-encoding") headers[k] = v;
      }
      headers["accept-encoding"] = "identity";
      headers["x-forwarded-by"] = "newsload-edge";
      const r = http.request(
        { hostname: base.hostname, port: base.port, path: req.url, method: req.method, headers, agent },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const out: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
            resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
          });
          res.on("error", reject);
        },
      );
      r.setTimeout(opts.timeoutMs ?? 10_000, () => r.destroy(new Error("upstream timeout")));
      r.on("error", reject);
      r.end();
    });
  return { upstream, agent };
}

export function writeResult(res: ServerResponse, method: string, result: EdgeResult): void {
  const { status, headers, body } = result.res;
  const out: Record<string, string | string[]> = { ...headers };
  out["x-cache"] = result.outcome;
  out["age"] = String(result.ageSec);
  out["content-length"] = String(body.length);
  res.writeHead(status, out);
  res.end(method === "HEAD" ? undefined : body);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

export interface EdgeServerOptions {
  cache: EdgeCache;
  secret?: string;
  purgeMode?: "soft" | "hard";
}

/** Admin endpoints live under /__edge/ and never reach the origin. */
export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  opts: EdgeServerOptions,
): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (!path?.startsWith("/__edge/")) return false;
  if (path === "/__edge/health") {
    json(res, 200, { ok: true });
    return true;
  }
  if (path === "/__edge/stats" && req.method === "GET") {
    json(res, 200, opts.cache.stats());
    return true;
  }
  if (!opts.secret || req.headers["x-lab-secret"] !== opts.secret) {
    json(res, opts.secret ? 401 : 503, { error: "bad or missing x-lab-secret" });
    return true;
  }
  if (path === "/__edge/stats" && req.method === "DELETE") {
    opts.cache.resetStats();
    json(res, 200, { reset: true });
    return true;
  }
  if (path === "/__edge/purge" && req.method === "POST") {
    let paths: unknown;
    let mode: unknown;
    try {
      ({ paths, mode } = JSON.parse(await readBody(req)) as { paths?: unknown; mode?: unknown });
    } catch {
      json(res, 400, { error: "body must be JSON {paths: string[]}" });
      return true;
    }
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.startsWith("/"))) {
      json(res, 400, { error: "paths must be an array of absolute paths" });
      return true;
    }
    const m = mode === "soft" || mode === "hard" ? mode : (opts.purgeMode ?? "hard");
    json(res, 200, { purged: opts.cache.purge(paths as string[], m), mode: m });
    return true;
  }
  json(res, 404, { error: "unknown admin endpoint" });
  return true;
}

export function createEdgeServer(opts: EdgeServerOptions): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (await handleAdmin(req, res, opts)) return;
        const edgeReq: EdgeRequest = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers };
        if (edgeReq.method !== "GET" && edgeReq.method !== "HEAD") {
          // Writes are not proxied in the lab (publish goes straight to Next.js).
          json(res, 405, { error: "edge only proxies GET/HEAD" });
          return;
        }
        writeResult(res, edgeReq.method, await opts.cache.handle(edgeReq));
      } catch (err) {
        if (!res.headersSent) json(res, 500, { error: (err as Error).message });
      }
    })();
  });
}
