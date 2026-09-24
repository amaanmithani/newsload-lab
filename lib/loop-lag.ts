import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Event-loop delay of the Next.js process. When the server is CPU-bound (or
 * the machine is), timers fire late: the simulated origin holds its pool slots
 * longer than ORIGIN_LATENCY_MS and throughput collapses. The lab records this
 * so an overload can be told apart from a slow origin.
 */
const KEY = Symbol.for("newsload-lab.loop-lag");
type G = typeof globalThis & { [KEY]?: IntervalHistogram };

function histogram(): IntervalHistogram {
  const g = globalThis as G;
  if (!g[KEY]) {
    g[KEY] = monitorEventLoopDelay({ resolution: 10 });
    g[KEY].enable();
  }
  return g[KEY];
}

const toMs = (ns: number) => Math.round((ns / 1e6) * 10) / 10;

export interface LoopLag {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export function loopLag(): LoopLag {
  const h = histogram();
  if (h.count === 0) return { p50Ms: 0, p99Ms: 0, maxMs: 0 };
  return { p50Ms: toMs(h.percentile(50)), p99Ms: toMs(h.percentile(99)), maxMs: toMs(h.max) };
}

export function resetLoopLag(): void {
  histogram().reset();
}
