import { describe, expect, it } from "vitest";
import { Origin, OriginOverloadedError, getOrigin, readOriginConfig, setOrigin } from "../lib/origin";

describe("simulated origin", () => {
  it("reads config from env with sane fallbacks", () => {
    expect(readOriginConfig({})).toEqual({ latencyMs: 120, maxConcurrency: 16, queueTimeoutMs: 2000 });
    expect(
      readOriginConfig({ ORIGIN_LATENCY_MS: "5", ORIGIN_MAX_CONCURRENCY: "0", ORIGIN_QUEUE_TIMEOUT_MS: "x" }),
    ).toEqual({ latencyMs: 5, maxConcurrency: 16, queueTimeoutMs: 2000 });
    expect(readOriginConfig({ ORIGIN_LATENCY_MS: " " }).latencyMs).toBe(120);
  });

  it("bounds concurrency, queues, and counts", async () => {
    const o = new Origin({ latencyMs: 10, maxConcurrency: 2, queueTimeoutMs: 1000 });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => o.query("read", async () => n)));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    await o.query("write", async () => null);
    const s = o.snapshot();
    expect(s).toMatchObject({ reads: 5, writes: 1, peakInFlight: 2, peakQueued: 3, inFlight: 0, queued: 0 });
    o.resetStats();
    expect(o.snapshot().reads).toBe(0);
  });

  it("rejects when the queue wait exceeds the timeout", async () => {
    const o = new Origin({ latencyMs: 100, maxConcurrency: 1, queueTimeoutMs: 20 });
    const first = o.query("read", async () => "ok");
    await expect(o.query("read", async () => "late")).rejects.toBeInstanceOf(OriginOverloadedError);
    await expect(first).resolves.toBe("ok");
    expect(o.snapshot().rejected).toBe(1);
  });

  it("releases the slot when work throws", async () => {
    const o = new Origin({ latencyMs: 0, maxConcurrency: 1, queueTimeoutMs: 50 });
    await expect(o.query("read", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(o.query("read", async () => 1)).resolves.toBe(1);
  });

  it("is a process-wide singleton that tests can replace", () => {
    const o = new Origin({ latencyMs: 0, maxConcurrency: 1, queueTimeoutMs: 1 });
    setOrigin(o);
    expect(getOrigin()).toBe(o);
  });
});
