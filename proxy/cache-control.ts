/** Minimal Cache-Control parser: just the directives a shared cache needs. */
export interface CacheDirectives {
  sMaxAge?: number;
  maxAge?: number;
  staleWhileRevalidate?: number;
  staleIfError?: number;
  noStore: boolean;
  noCache: boolean;
  private: boolean;
}

export function parseCacheControl(value: string | null | undefined): CacheDirectives {
  const d: CacheDirectives = { noStore: false, noCache: false, private: false };
  if (!value) return d;
  for (const part of value.split(",")) {
    const [rawName, rawVal] = part.split("=", 2);
    const name = rawName?.trim().toLowerCase();
    const num = rawVal === undefined ? NaN : Number(rawVal.trim().replace(/^"|"$/g, ""));
    const secs = Number.isFinite(num) && num >= 0 ? num : undefined;
    switch (name) {
      case "s-maxage":
        d.sMaxAge = secs;
        break;
      case "max-age":
        d.maxAge = secs;
        break;
      case "stale-while-revalidate":
        d.staleWhileRevalidate = secs;
        break;
      case "stale-if-error":
        d.staleIfError = secs;
        break;
      case "no-store":
        d.noStore = true;
        break;
      case "no-cache":
        d.noCache = true;
        break;
      case "private":
        d.private = true;
        break;
    }
  }
  return d;
}

export interface Freshness {
  ttlMs: number;
  swrMs: number;
  sieMs: number;
}

export interface FreshnessPolicy {
  /** Upper bound on the SWR window, whatever the origin asks for. */
  maxSwrMs: number;
  /** stale-if-error window used when the origin does not send one. */
  defaultSieMs: number;
}

/**
 * Shared-cache freshness for a response, or null if it must not be stored.
 * s-maxage wins over max-age (RFC 9111 §5.2.2.10).
 */
export function freshnessFor(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  policy: FreshnessPolicy,
): Freshness | null {
  if (![200, 203, 204, 300, 301, 308, 404, 410].includes(status)) return null;
  if (headers["set-cookie"] !== undefined) return null;
  const cc = headers["cache-control"];
  const d = parseCacheControl(Array.isArray(cc) ? cc.join(",") : cc);
  if (d.noStore || d.private || d.noCache) return null;
  const ttl = d.sMaxAge ?? d.maxAge;
  if (ttl === undefined || ttl <= 0) return null;
  return {
    ttlMs: ttl * 1000,
    swrMs: Math.min((d.staleWhileRevalidate ?? 0) * 1000, policy.maxSwrMs),
    sieMs: (d.staleIfError ?? policy.defaultSieMs / 1000) * 1000,
  };
}
