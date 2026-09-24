import { cacheKey, type HeaderBag, type KeyOptions } from "./cache-key.ts";
import { freshnessFor } from "./cache-control.ts";

/**
 * Transport-agnostic edge cache: stale-while-revalidate, request coalescing
 * (single-flight) on miss, stale-if-error, hit-for-pass for uncacheable URLs,
 * soft/hard purge and a bounded LRU. server.ts wires it to node:http.
 */

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
}

export interface EdgeRequest {
  method: string;
  url: string;
  headers: HeaderBag;
}

export type Upstream = (req: EdgeRequest) => Promise<UpstreamResponse>;

export type Outcome = "HIT" | "STALE" | "MISS" | "COALESCED" | "PASS" | "BYPASS" | "STALE-IF-ERROR" | "ERROR";

export interface EdgeResult {
  outcome: Outcome;
  res: UpstreamResponse;
  /** Seconds since the cached copy was fetched (0 for fresh upstream responses). */
  ageSec: number;
}

export interface EdgeOptions {
  upstream: Upstream;
  now?: () => number;
  maxEntries?: number;
  /** Cap on the origin's stale-while-revalidate. */
  maxSwrMs?: number;
  /** stale-if-error window when the origin does not specify one. */
  defaultSieMs?: number;
  /** How long a URL that returned an uncacheable response skips coalescing. */
  hitForPassMs?: number;
  keyOptions?: KeyOptions;
}

export interface EdgeStats {
  requests: number;
  hit: number;
  stale: number;
  miss: number;
  coalesced: number;
  pass: number;
  bypass: number;
  staleIfError: number;
  errors: number;
  upstreamFetches: number;
  upstreamErrors: number;
  backgroundRevalidations: number;
  purged: number;
  evicted: number;
  entries: number;
  inflight: number;
}

interface Entry {
  path: string;
  res: UpstreamResponse;
  storedAt: number;
  ttlMs: number;
  swrMs: number;
  sieMs: number;
}

interface Flight {
  promise: Promise<UpstreamResponse>;
}

const EMPTY_STATS = (): Omit<EdgeStats, "entries" | "inflight"> => ({
  requests: 0,
  hit: 0,
  stale: 0,
  miss: 0,
  coalesced: 0,
  pass: 0,
  bypass: 0,
  staleIfError: 0,
  errors: 0,
  upstreamFetches: 0,
  upstreamErrors: 0,
  backgroundRevalidations: 0,
  purged: 0,
  evicted: 0,
});

const BAD_GATEWAY = (msg: string): UpstreamResponse => ({
  status: 502,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: Buffer.from(`edge: upstream error: ${msg}\n`),
});

function outcomeCounter(o: Outcome): keyof ReturnType<typeof EMPTY_STATS> {
  switch (o) {
    case "HIT":
      return "hit";
    case "STALE":
      return "stale";
    case "MISS":
      return "miss";
    case "COALESCED":
      return "coalesced";
    case "PASS":
      return "pass";
    case "BYPASS":
      return "bypass";
    case "STALE-IF-ERROR":
      return "staleIfError";
    case "ERROR":
      return "errors";
  }
}

export class EdgeCache {
  private readonly upstream: Upstream;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxSwrMs: number;
  private readonly defaultSieMs: number;
  private readonly hitForPassMs: number;
  private readonly keyOptions: KeyOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Flight>();
  private readonly passUntil = new Map<string, number>();
  private counters = EMPTY_STATS();

  constructor(opts: EdgeOptions) {
    this.upstream = opts.upstream;
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.maxSwrMs = opts.maxSwrMs ?? 60_000;
    this.defaultSieMs = opts.defaultSieMs ?? 300_000;
    this.hitForPassMs = opts.hitForPassMs ?? 10_000;
    this.keyOptions = opts.keyOptions ?? {};
  }

  stats(): EdgeStats {
    return { ...this.counters, entries: this.entries.size, inflight: this.inflight.size };
  }

  resetStats(): void {
    this.counters = EMPTY_STATS();
  }

  /** Remove every variant of the given paths. soft = mark stale (served while refetching); hard = delete. */
  purge(paths: readonly string[], mode: "soft" | "hard" = "hard"): number {
    const wanted = new Set(paths.map((p) => cacheKey(p).path));
    let n = 0;
    for (const [key, e] of this.entries) {
      if (!wanted.has(e.path)) continue;
      n++;
      if (mode === "hard") this.entries.delete(key);
      else e.storedAt = Math.min(e.storedAt, this.now() - e.ttlMs);
    }
    for (const key of this.passUntil.keys()) {
      if (wanted.has(cacheKey(key.split("#")[0] ?? "/").path)) this.passUntil.delete(key);
    }
    this.counters.purged += n;
    return n;
  }

  async handle(req: EdgeRequest): Promise<EdgeResult> {
    this.counters.requests++;
    const result = await this.route(req);
    this.counters[outcomeCounter(result.outcome)]++;
    return result;
  }

  private isBypass(req: EdgeRequest): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return true;
    if (req.headers.authorization) return true;
    const cookie = req.headers.cookie;
    const c = Array.isArray(cookie) ? cookie.join(";") : (cookie ?? "");
    return /(^|;\s*)(__session|session|auth[\w-]*)=/i.test(c);
  }

  private async route(req: EdgeRequest): Promise<EdgeResult> {
    if (this.isBypass(req)) return { outcome: "BYPASS", res: await this.fetchDirect(req), ageSec: 0 };

    const { key, path } = cacheKey(req.url, req.headers, this.keyOptions);
    const now = this.now();

    const pass = this.passUntil.get(key);
    if (pass !== undefined) {
      if (pass > now) return { outcome: "PASS", res: await this.fetchDirect(req), ageSec: 0 };
      this.passUntil.delete(key);
    }

    const entry = this.entries.get(key);
    if (entry) {
      const age = now - entry.storedAt;
      if (age < entry.ttlMs) {
        this.touch(key, entry);
        return { outcome: "HIT", res: entry.res, ageSec: Math.floor(age / 1000) };
      }
      if (age < entry.ttlMs + entry.swrMs) {
        this.touch(key, entry);
        this.revalidateInBackground(key, path, req);
        return { outcome: "STALE", res: entry.res, ageSec: Math.floor(age / 1000) };
      }
    }

    // Miss (or too stale to serve without asking): single-flight to the origin.
    const leader = !this.inflight.has(key);
    let res: UpstreamResponse;
    try {
      res = await this.fetchShared(key, path, req);
    } catch (err) {
      return this.onError(key, entry, (err as Error).message);
    }
    if (res.status >= 500) return this.onError(key, entry, `status ${res.status}`, res);
    if (!leader && !this.entries.has(key)) {
      // Shared answer was not cacheable (e.g. a personalised or dynamic page):
      // it may not be valid for this caller, so fetch our own copy.
      return { outcome: "PASS", res: await this.fetchDirect(req), ageSec: 0 };
    }
    return { outcome: leader ? "MISS" : "COALESCED", res, ageSec: 0 };
  }

  private onError(key: string, entry: Entry | undefined, msg: string, res?: UpstreamResponse): EdgeResult {
    const current = this.entries.get(key) ?? entry;
    if (current && this.now() - current.storedAt < current.ttlMs + current.sieMs) {
      return {
        outcome: "STALE-IF-ERROR",
        res: current.res,
        ageSec: Math.floor((this.now() - current.storedAt) / 1000),
      };
    }
    return { outcome: "ERROR", res: res ?? BAD_GATEWAY(msg), ageSec: 0 };
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private async fetchDirect(req: EdgeRequest): Promise<UpstreamResponse> {
    this.counters.upstreamFetches++;
    try {
      return await this.upstream(req);
    } catch (err) {
      this.counters.upstreamErrors++;
      return BAD_GATEWAY((err as Error).message);
    }
  }

  /** One upstream request per key at a time; everyone else awaits the same promise. */
  private fetchShared(key: string, path: string, req: EdgeRequest): Promise<UpstreamResponse> {
    const existing = this.inflight.get(key);
    if (existing) return existing.promise;
    const upstreamReq: EdgeRequest = { ...req, method: "GET" };
    this.counters.upstreamFetches++;
    const promise = this.upstream(upstreamReq)
      .then((res) => {
        this.store(key, path, res);
        return res;
      })
      .catch((err: unknown) => {
        this.counters.upstreamErrors++;
        throw err;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, { promise });
    return promise;
  }

  private revalidateInBackground(key: string, path: string, req: EdgeRequest): void {
    if (this.inflight.has(key)) return;
    this.counters.backgroundRevalidations++;
    // Errors keep the stale copy; they are counted in upstreamErrors.
    this.fetchShared(key, path, req).catch(() => undefined);
  }

  private store(key: string, path: string, res: UpstreamResponse): void {
    if (res.status >= 500) return; // keep any existing copy for stale-if-error
    const f = freshnessFor(res.status, res.headers, { maxSwrMs: this.maxSwrMs, defaultSieMs: this.defaultSieMs });
    if (!f) {
      this.entries.delete(key);
      this.passUntil.set(key, this.now() + this.hitForPassMs);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { path, res, storedAt: this.now(), ...f });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.counters.evicted++;
    }
  }
}
