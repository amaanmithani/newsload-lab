# Running this behind Cloudflare (documented, not deployed)

Nothing in this repo creates a Cloudflare account, zone or rule. This file maps
the local edge proxy (`proxy/`) onto the Cloudflare features you would use for
the same behaviour in production. Plan-specific details change over time;
verify each row against the current Cloudflare docs before relying on it.

| Local proxy behaviour                                                 | Cloudflare equivalent                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Honour `s-maxage` from Next.js ISR pages                              | Cache Rule → _Eligible for cache_, Edge TTL: **Use cache-control header if present**                                                                                                                                                                                                       |
| `stale-while-revalidate` (capped at 60 s)                             | Cloudflare honours `stale-while-revalidate` in the origin's `Cache-Control`; check whether revalidation is asynchronous on your plan. Cap the window at the origin (`expireTime` in `next.config.ts`).                                                                                     |
| `stale-if-error`                                                      | Honoured from `Cache-Control`; also _Always Online_ for HTML as a last resort                                                                                                                                                                                                              |
| Single-flight on miss                                                 | Cloudflare's cache collapses concurrent misses for the same URL within a data centre (confirm for HTML on your plan). Add **Tiered Cache** (Smart Tiered Topology) so colos collapse onto one upper tier, and the origin sees roughly one request per URL per TTL instead of one per colo. |
| Cache-key normalisation (drop `utm_*`, `fbclid`, `gclid`, sort query) | Cache Rule → Cache key → Query string: **Ignore** or an allow-list; query-string sorting is a plan-dependent option; otherwise use a Transform Rule to strip tracking params                                                                                                               |
| Separate `rsc: 1` (React Server Components) variant                   | Cache Rule → Cache key → **Header: `RSC`, `Next-Router-Prefetch`, `Next-Router-Segment-Prefetch`** (custom cache key on headers needs Enterprise); on lower plans, bypass cache when `http.request.headers["rsc"][0] eq "1"`                                                               |
| Bypass for `Authorization` / session cookies                          | Cache Rule: `any(http.request.headers.names[*] eq "authorization") or http.cookie contains "__session"` → _Bypass cache_                                                                                                                                                                   |
| Hit-for-pass on `private, no-store`                                   | Automatic: Cloudflare will not store responses marked `private`/`no-store` or carrying `Set-Cookie`                                                                                                                                                                                        |
| `POST /__edge/purge` on publish                                       | `POST https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache` with `{"files": ["https://example.com/news/<slug>", "https://example.com/"]}` from `app/api/publish/route.ts` (set `CDN_PURGE_URL` to a small adapter, or replace `lib/purge.ts`)                                  |

## Example Cache Rules (expressions)

```text
# 1. Articles and home page: cache, respect origin Cache-Control
(http.request.uri.path eq "/" or starts_with(http.request.uri.path, "/news/"))
  and not any(http.request.headers.names[*] eq "authorization")
  and not http.cookie contains "__session"
  -> Eligible for cache; Edge TTL: use cache-control header if present, else 30s;
     Browser TTL: respect origin; Cache key: ignore query string (or allow-list "page")

# 2. Never cache the admin/API surface or the dynamic baseline
starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/live/")
  -> Bypass cache

# 3. Next.js static assets: immutable
starts_with(http.request.uri.path, "/_next/static/")
  -> Eligible for cache; Edge TTL 1 year (origin already sends immutable)
```

## Origin headers this relies on

`next start` sends, for an ISR page with `revalidate = 30` and `expireTime = 300`:

```text
Cache-Control: s-maxage=30, stale-while-revalidate=270
```

and for the dynamic `/live/*` baseline:

```text
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
```

## Things the local lab cannot show

- Multiple PoPs: each Cloudflare colo has its own cache, so a global spike
  produces up to one origin miss per colo per TTL unless Tiered Cache is on.
- Real network RTT, TLS, HTTP/2 multiplexing and compression (the lab uses
  plain HTTP/1.1 on loopback with `compress: false`).
- Purge propagation delay: Cloudflare purges are global but not instantaneous
  (typically well under a few seconds); the local purge is synchronous.
