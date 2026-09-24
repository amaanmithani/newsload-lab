/**
 * Simulated "slow origin" (think: a CMS database behind the news site).
 *
 * Every query:
 *   1. waits for a slot in a bounded connection pool (ORIGIN_MAX_CONCURRENCY),
 *      giving up with OriginOverloadedError after ORIGIN_QUEUE_TIMEOUT_MS;
 *   2. sleeps ORIGIN_LATENCY_MS to model query + network time;
 *   3. runs the real work (reading the JSON store).
 *
 * The pool limit is what makes "origin only" fall over under a spike: once
 * arrivals exceed maxConcurrency / latency the queue grows until requests time
 * out. Counters live on globalThis so every Next.js bundle (pages and route
 * handlers are compiled into separate chunks) shares one set per process.
 */

export interface OriginConfig {
  latencyMs: number;
  maxConcurrency: number;
  queueTimeoutMs: number;
}

export interface OriginStats {
  reads: number;
  writes: number;
  rejected: number;
  inFlight: number;
  peakInFlight: number;
  queued: number;
  peakQueued: number;
  since: string;
}

export class OriginOverloadedError extends Error {
  constructor(waitedMs: number) {
    super(`origin overloaded: no pool slot after ${waitedMs}ms`);
    this.name = "OriginOverloadedError";
  }
}

function intFromEnv(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

export function readOriginConfig(env: Record<string, string | undefined> = process.env): OriginConfig {
  return {
    latencyMs: intFromEnv(env.ORIGIN_LATENCY_MS, 120, 0),
    maxConcurrency: intFromEnv(env.ORIGIN_MAX_CONCURRENCY, 16, 1),
    queueTimeoutMs: intFromEnv(env.ORIGIN_QUEUE_TIMEOUT_MS, 2000, 1),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Waiter = { grant: () => void; timer: ReturnType<typeof setTimeout> };

export class Origin {
  readonly config: OriginConfig;
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private stats: OriginStats;

  constructor(config: OriginConfig) {
    this.config = config;
    this.stats = Origin.emptyStats();
  }

  private static emptyStats(): OriginStats {
    return {
      reads: 0,
      writes: 0,
      rejected: 0,
      inFlight: 0,
      peakInFlight: 0,
      queued: 0,
      peakQueued: 0,
      since: new Date().toISOString(),
    };
  }

  snapshot(): OriginStats {
    return { ...this.stats, inFlight: this.active, queued: this.waiters.length };
  }

  resetStats(): void {
    this.stats = Origin.emptyStats();
  }

  private acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrency) {
      this.active++;
      this.stats.peakInFlight = Math.max(this.stats.peakInFlight, this.active);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          this.active++;
          this.stats.peakInFlight = Math.max(this.stats.peakInFlight, this.active);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          this.stats.rejected++;
          reject(new OriginOverloadedError(this.config.queueTimeoutMs));
        }, this.config.queueTimeoutMs),
      };
      this.waiters.push(waiter);
      this.stats.peakQueued = Math.max(this.stats.peakQueued, this.waiters.length);
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next.grant();
  }

  async query<T>(kind: "read" | "write", work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (kind === "read") this.stats.reads++;
      else this.stats.writes++;
      if (this.config.latencyMs > 0) await sleep(this.config.latencyMs);
      return await work();
    } finally {
      this.release();
    }
  }
}

const KEY = Symbol.for("newsload-lab.origin");
type GlobalWithOrigin = typeof globalThis & { [KEY]?: Origin };

export function getOrigin(): Origin {
  const g = globalThis as GlobalWithOrigin;
  g[KEY] ??= new Origin(readOriginConfig());
  return g[KEY];
}

/** Test hook: replace the process-wide origin (e.g. with zero latency). */
export function setOrigin(origin: Origin): void {
  (globalThis as GlobalWithOrigin)[KEY] = origin;
}
