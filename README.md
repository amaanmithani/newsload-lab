# newsload-lab — how a news site survives a breaking-news spike

A small, fully local lab that answers one question with measurements rather
than folklore: **what actually keeps a news article up when everyone opens it at
once?** It compares three ways of serving the same Next.js article page under
k6 load:

| Configuration | Path served | What protects the slow origin |
|---|---|---|
| **Origin only** | `GET /live/<slug>` (`dynamic = "force-dynamic"`) | Nothing. Every request renders and queries the origin. |
| **Next ISR only** | `GET /news/<slug>` (`revalidate = 30`) | Next.js' incremental static regeneration cache, plus on-demand `revalidatePath` on publish. |
| **ISR + edge proxy** | `GET :8080/news/<slug>` → Next.js | A caching reverse proxy written for this repo: stale-while-revalidate, request coalescing (single-flight), stale-if-error, cache-key normalisation, purge on publish. |

> **Honesty note.** This is a laptop. It cannot generate "100k concurrent
> users", and nothing here claims to. Every run reports the arrival rate that
> was *achieved*, how many iterations k6 had to drop, the number of VUs it
> needed, and the machine's load average. k6, the proxy and Next.js all share
> the same CPUs (and, during these runs, the machine was also running unrelated
> jobs), so absolute numbers are a lower bound on what the software can do and
> the *relative* differences are the point.

## Architecture

```text
             k6 (load/*.js)
   ┌────────────┼──────────────────────────┐
   │            │                          │
   │  origin    │  isr                     │  edge
   ▼            ▼                          ▼
 /live/<slug>  /news/<slug>        edge proxy :8080  (proxy/)
   │            │                  - cache key: path + sorted, de-tracked query + RSC variant
   │            │                  - honour s-maxage / stale-while-revalidate / stale-if-error
   │            │                  - single-flight on miss, hit-for-pass on private/no-store
   │            │                  - LRU bound, POST /__edge/purge
   │            │                          │
   └────────────┴───────────┬──────────────┘
                            ▼
              Next.js 16 App Router :3000  (app/)
              - /news/[slug]: ISR, revalidate 30 s, lazily generated
              - /live/[slug]: force-dynamic baseline
              - POST /api/publish: write → revalidatePath(article, "/") → purge edge
                            │
                            ▼
              simulated slow origin (lib/origin.ts + lib/store.ts)
              - JSON file store (data/seed.json → .data/*.json)
              - ORIGIN_LATENCY_MS per query (default 120 ms)
              - pool of ORIGIN_MAX_CONCURRENCY slots (default 16),
                queue timeout ORIGIN_QUEUE_TIMEOUT_MS (default 2000 ms) → HTTP 500
```

The pool is what makes the origin fall over realistically: at 120 ms per
query and 16 slots it can serve at most ~133 reads/s; beyond that the queue
grows until requests time out, exactly like a CMS database under a spike.

Key files:

- `proxy/edge-cache.ts` — transport-agnostic cache (SWR, single-flight, stale-if-error, hit-for-pass, purge, LRU)
- `proxy/cache-key.ts` — key normalisation (tracking params, trailing slashes, query order, `rsc` variants)
- `proxy/server.ts`, `proxy/main.ts` — `node:http` server with keep-alive upstream pool, run directly by Node's TypeScript type stripping (no build step)
- `app/api/publish/route.ts` — on-demand revalidation + edge purge
- `load/*.js` — k6 scenarios; `scripts/lab.mjs` — orchestrator; `scripts/render-results.mjs` — README tables
- `deploy/cloudflare.md` — how the same behaviour maps to Cloudflare cache rules and headers (documented only; nothing is deployed)

### Headers the proxy relies on

`next start` sends `Cache-Control: s-maxage=30, stale-while-revalidate=270` for
ISR pages (`expireTime: 300` in `next.config.ts` caps Next's default one-year
SWR window) and `private, no-cache, no-store, max-age=0, must-revalidate` for
the dynamic baseline. The proxy stores the first, passes the second through
(and remembers not to coalesce that URL for 10 s — Varnish-style hit-for-pass,
so personalised responses are never shared between users).

### Publish flow

`POST /api/publish {slug, headline?, ...}` with `x-lab-secret`:

1. writes the story (bumps `rev`),
2. `revalidatePath("/news/<slug>")` and `revalidatePath("/")`,
3. if `CDN_PURGE_URL` is set, `POST`s the same paths to the edge purge endpoint.

Verified behaviour in Next.js 16.3.6: after `revalidatePath` from a route
handler, the next request to that path is a *blocking* regeneration
(`x-nextjs-cache: MISS`) and returns the new revision, so a hard purge at the
edge followed by a coalesced miss yields fresh content without serving the
old copy again.

## Running it

Requirements: Node ≥ 22.18 (for TypeScript type stripping in the proxy), k6
(`~/.local/bin/k6` or on `PATH`, or set `K6_BIN`). No Docker, no cloud.

```bash
npm ci
npm run build            # next build (the lab runner also does this if needed)

npm run lab:steady       # 100 req/s for 30 s across 12 articles
npm run lab:spike        # 50 → 1,500 req/s on one hot article (45 s)
npm run lab:publish      # 300 req/s on the hot article, story updated at t = 15 s (40 s)
npm run lab:herd         # 1,000 VUs request a cold article at the same instant
npm run results:render   # regenerate the tables below from results/
```

Each `lab:*` command runs the scenario against all three configurations in
turn (`node scripts/lab.mjs spike isr,edge` runs a subset). For every
configuration the runner starts fresh `next start` (and proxy) processes,
restores the seed data, warms caches (except for `herd`), zeroes counters,
runs k6, records origin/edge counters and load average, and kills every
process it started. Knobs: `RATE`, `PEAK_RATE`, `DURATION`, `HOLD`, `MAX_VUS`,
`HERD`, `ORIGIN_LATENCY_MS`, `ORIGIN_MAX_CONCURRENCY`, `LOAD_ABORT` (stop k6
if the 1-minute load average exceeds it; default 5 × CPUs), `LOAD_START_MAX`.
k6 never runs more than 1,500 VUs by default.

Run the pieces by hand:

```bash
LAB_SECRET=dev npm start                                        # Next.js on :3000
LAB_SECRET=dev EDGE_ORIGIN=http://127.0.0.1:3000 npm run proxy  # edge on :8080
curl -si localhost:8080/news/election-results-live | grep -i -E 'x-cache|age|x-nextjs'
curl -s -XPOST localhost:3000/api/publish -H 'x-lab-secret: dev' \
     -H 'content-type: application/json' -d '{"slug":"election-results-live","headline":"Update"}'
curl -s localhost:3000/api/stats; curl -s localhost:8080/__edge/stats
```

## Results

Raw k6 summaries (`results/<scenario>/<config>.k6.json`, written by k6's
`handleSummary`) and the runner's counters (`results/<scenario>/<config>.lab.json`)
are committed. The tables below are generated from those files by
`scripts/render-results.mjs`; CI fails if they drift (`npm run results:check`).

Column notes: *Achieved rate* is completed requests ÷ whole test duration
(including ramp-up/down), so it is below the peak target for the spike even
when nothing is dropped. *Dropped iterations* are arrivals k6 could not start
because every VU was busy — offered load that was never sent. *Network* errors
are k6-side failures (timeouts after 10 s, connection resets) and *5xx* are
server errors (the origin pool timing out). *Requests reaching Next.js* is
every request for the first two configurations and the proxy's upstream
fetches for the third.

<!-- RESULTS:START (generated by scripts/render-results.mjs; do not edit by hand) -->

**Machine:** Apple M1 Pro, 8 logical CPUs, 16 GiB RAM, macOS 26.6.2 (arm64); Node v25.9.0; Next.js 16.3.6; k6 v2.3.0 (commit/e088784614, go1.26.8, darwin/arm64).
k6, the edge proxy and Next.js all ran on this one machine, alongside unrelated background jobs.

Simulated origin: 120 ms per query, pool of 16 concurrent queries, queue timeout 2000 ms (≈ 133 reads/s ceiling). ISR revalidate = 30 s.

### Steady load (normal news day, 25% of traffic on the lead story)

Offered load: **100/s constant, 30s**.

| Configuration | Requests | Achieved rate | p50 | p95 | p99 | Error rate (network / 5xx) | Dropped iterations | Max VUs | Requests reaching Next.js | Slow-origin reads | Next.js event-loop delay p99 | Peak 1-min load avg |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Origin only (`/live`, dynamic) | 2,978 | 97/s | 124.8 ms | 1.01 s | 1.19 s | 0.00% (0 net / 0 5xx) | 23 | 121 | 2,978 | 2,978 (0 rejected) | 49.0 ms | 12.7 |
| Next ISR only (`/news`) | 2,909 | 97/s | 1.5 ms | 623.5 ms | 1.71 s | 0.00% (0 net / 0 5xx) | 91 | 116 | 2,909 | 11 (0 rejected) | 27.0 ms | 18.9 |
| ISR + edge proxy (SWR + coalescing) | 3,001 | 100/s | 0.5 ms | 3.5 ms | 11.4 ms | 0.00% (0 net / 0 5xx) | 0 | 100 | 11 | 11 (0 rejected) | 16.7 ms | 13.8 |

### Breaking-news spike (90% of traffic on one article)

Offered load: **50/s → 1500/s (hold 20s)**.

| Configuration | Requests | Achieved rate | p50 | p95 | p99 | Error rate (network / 5xx) | Dropped iterations | Max VUs | Requests reaching Next.js | Slow-origin reads | Next.js event-loop delay p99 | Peak 1-min load avg |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Origin only (`/live`, dynamic) | 10,596 | 216/s | 2.70 s | 7.55 s | 10.00 s | 78.80% (2,002 net / 6,348 5xx) | 31,403 | 1,500 | 10,596 | 2,292 (6,847 rejected) | 321.4 ms | 10.5 |
| Next ISR only (`/news`) | 26,401 | 521/s | 1.2 ms | 972.8 ms | 7.01 s | 8.72% (2,301 net / 0 5xx) | 15,248 | 1,500 | 26,401 | 12 (0 rejected) | 122.5 ms | 31.3 |
| ISR + edge proxy (SWR + coalescing) | 32,763 | 728/s | 0.4 ms | 154.0 ms | 1.65 s | 0.00% (0 net / 0 5xx) | 9,236 | 274 | 12 | 12 (0 rejected) | 29.0 ms | 24.6 |

### Publish during spike (story updated mid-run)

Offered load: **300/s constant, 40s, publish at 15 s**.

| Configuration | Requests | Achieved rate | p50 | p95 | p99 | Error rate (network / 5xx) | Dropped iterations | Max VUs | Requests reaching Next.js | Slow-origin reads | Next.js event-loop delay p99 | Peak 1-min load avg |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Origin only (`/live`, dynamic) | 6,301 | 130/s | 562.8 ms | 10.10 s | 10.85 s | 86.56% (4,300 net / 1,155 5xx) | 5,724 | 1,501 | 6,301 | 1,021 (2,128 rejected) | 1.07 s | 23.7 |
| Next ISR only (`/news`) | 11,943 | 298/s | 1.8 ms | 717.9 ms | 1.20 s | 0.00% (0 net / 0 5xx) | 58 | 330 | 11,943 | 1 (0 rejected) | 162.3 ms | 17.3 |
| ISR + edge proxy (SWR + coalescing) | 11,954 | 299/s | 0.4 ms | 69.7 ms | 952.6 ms | 0.00% (0 net / 0 5xx) | 47 | 304 | 1 | 1 (0 rejected) | 21.4 ms | 16.7 |

| Configuration | Publish result | Publish call took | Staleness window after publish ack | First fresh request started after publish sent | Stale responses to requests started after publish was sent | Stale responses (total) | Fresh responses | Slow-origin reads |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| Origin only (`/live`, dynamic) | **failed** | 7.80 s | n/a: story never updated | – | 75 | 847 | 0 | 1,021 |
| Next ISR only (`/news`) | 200 OK | 148.0 ms | 0.0 ms | 146.0 ms | 45 | 4,487 | 7,456 | 1 |
| ISR + edge proxy (SWR + coalescing) | 200 OK | 151.0 ms | 0.0 ms | 150.0 ms | 44 | 4,498 | 7,456 | 1 |

### Thundering herd on a cold article

Offered load: **1000 VUs × 1 request, simultaneous**.

| Configuration | Requests | Achieved rate | p50 | p95 | p99 | Error rate (network / 5xx) | Dropped iterations | Max VUs | Requests reaching Next.js | Slow-origin reads | Next.js event-loop delay p99 | Peak 1-min load avg |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Origin only (`/live`, dynamic) | 1,000 | 127/s | 1.37 s | 3.19 s | 3.51 s | 29.40% (207 net / 87 5xx) | 0 | 1,000 | 1,000 | 706 (87 rejected) | 32.2 ms | 13.3 |
| Next ISR only (`/news`) | 1,000 | 457/s | 183.2 ms | 358.0 ms | 362.5 ms | 0.00% (0 net / 0 5xx) | 0 | 1,000 | 1,000 | 1 (0 rejected) | 42.8 ms | 11.1 |
| ISR + edge proxy (SWR + coalescing) | 1,000 | 2143/s | 293.7 ms | 396.6 ms | 399.1 ms | 0.00% (0 net / 0 5xx) | 0 | 1,000 (configured; run too short to sample) | 1 | 1 (0 rejected) | 94.8 ms | 10.0 |

### What the edge proxy did

| Scenario | Edge requests | HIT | STALE (served, refreshed in background) | MISS | COALESCED | PASS | Upstream fetches | Background revalidations | Purged entries | Offload |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| steady | 3,001 | 2,990 | 11 | 0 | 0 | 0 | 11 | 11 | 0 | 99.63% |
| spike | 32,763 | 32,499 | 264 | 0 | 0 | 0 | 12 | 12 | 0 | 99.96% |
| publish | 11,954 | 11,914 | 0 | 1 | 39 | 0 | 1 | 0 | 1 | 99.99% |
| herd | 1,000 | 0 | 0 | 1 | 999 | 0 | 1 | 0 | 0 | 99.90% |

<!-- RESULTS:END -->

## What the numbers mean

Figures quoted here are copied from the committed run rendered above; if you
re-run the lab, trust the tables, not this prose.

1. **Origin only collapses once arrivals pass the pool's ceiling.** Steady
   load (100/s, under the ~133 reads/s ceiling) survives but already queues
   (p95 1.01 s). In the spike the pool rejected 6,847 queries, 78.80% of
   requests failed, and k6 still could not offer most of the load: 31,403
   iterations were dropped because all 1,500 VUs were stuck waiting. The
   failure is metastable: error pages and timers firing late (Next.js
   event-loop delay p99 321.4 ms) make each slot slower, which makes the queue
   longer.
2. **In the publish run the editor could not publish at all under origin-only.**
   The CMS write waits in the same pool as the readers. It took 7.80 s and
   failed, so the story was never updated. Caching read traffic protects
   the write path too.
3. **ISR moves the bottleneck from the database to the Node.js process.** In
   every warm scenario the slow origin saw about one read per article per
   30 s (11–12 reads in 30–45 s runs). The single `next start` process then
   becomes the limit: in the spike it completed 521/s with 8.72% network
   errors (connection resets and 10 s timeouts once its accept queue
   overflowed; macOS' default listen backlog is 128) and 15,248 dropped
   iterations.
4. **The edge proxy removes the Node.js process from the hot path.** Only 12
   of 32,763 spike requests reached Next.js (99.96% offload), with no errors
   and a p50 of 0.4 ms. The spike's remaining dropped iterations (9,236, with
   only 274 VUs in use) come from the load generator: the machine's 1-minute
   load average peaked at 24.6, and k6 could not start iterations fast
   enough. **1,500 req/s was more than this laptop could generate while
   also serving it.** The spike is capped by the generator, not by the proxy.
5. **Coalescing.** Next.js 16 already single-flights ISR regeneration
   internally: in the herd test 1,000 simultaneous requests for a cold article
   caused 1 origin read with or without the proxy. The proxy's coalescing
   protects the *Next.js process*: 999 of the 1,000 herd requests were
   COALESCED onto one upstream fetch. In the publish run, the purge produced 1 MISS
   and 39 COALESCED requests, not 40 renders. Without ISR (origin only) the
   same herd produced 706 origin reads and 29.40% errors.
6. **Staleness after publish is bounded by the publish call, not the TTL.**
   With on-demand `revalidatePath` (+ edge purge), no request that *started*
   after the publish was acknowledged got the old story (staleness window
   0.0 ms for both ISR and ISR + edge). The first fresh response came from a
   request started ~150 ms after the publish was sent, which is roughly the
   write latency. The 44–45 stale responses "after publish" are requests
   issued while the publish call was still in flight. Without the purge, the
   edge would keep serving the old page for up to `s-maxage` (30 s) plus SWR.
7. **Tail latency on the cached paths comes from the machine.** Edge p99 is
   far above its p50 in the spike and publish runs because k6, Next.js, the
   proxy and unrelated background jobs were all competing for 8 cores. The
   origin counters, error rates and offload ratios are the parts that carry
   over to real hardware; the absolute latencies do not.

## Limits and caveats

- **One machine.** Load generator, proxy and server compete for the same CPU
  cores; the load generator's own cost is part of every latency number, and
  unrelated background jobs were running. Absolute throughput here says
  little about a real deployment; the ratios between configurations are the
  finding.
- **Loopback network.** No RTT, TLS, HTTP/2 or compression (Next's `compress`
  is off so all three configurations send identical bytes).
- **One PoP.** A real CDN has many caches; without tiered caching a global
  spike yields up to one origin miss per PoP per TTL. See `deploy/cloudflare.md`.
- **Simulated origin.** Latency and the connection pool are modelled with
  timers, not a real database. The pool limit (16) and latency (120 ms) are
  arbitrary but documented; change them with env vars.
- **macOS listen backlog.** `kern.ipc.somaxconn` defaults to 128 on macOS, so a
  single Node process that falls behind starts refusing/resetting connections;
  that shows up as network errors in k6, not as 5xx.
- **Short runs.** 30–60 s per configuration, one run each; there is run-to-run
  variance, especially with other jobs on the machine. Re-run and compare.
- **Staleness is measured at request start** with millisecond clocks inside
  k6; the publish call itself is included in the window.

## Development

```bash
npm run lint && npm run type-check && npm run format:check
npm run test:coverage     # vitest + v8 coverage, 75% thresholds
npm run build
```

CI (`.github/workflows/ci.yml`) runs quality (lint, typecheck, format, README
results check) → test (coverage) → build. It never runs the load tests.
