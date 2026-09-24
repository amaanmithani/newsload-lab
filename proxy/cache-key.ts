/**
 * Cache-key normalisation. Two requests that should get the same bytes must
 * map to the same key, and requests that must NOT share bytes must not.
 *
 *  - path: percent-decoding is left alone, but duplicate slashes are collapsed
 *    and a trailing slash is dropped ("/news/a/" == "/news/a").
 *  - query: tracking params (utm_*, fbclid, gclid, ...) are dropped, remaining
 *    params are sorted, and only an allow-list survives if one is configured.
 *  - variant: Next.js serves RSC flight data for the SAME URL when the request
 *    carries `rsc: 1` (client navigations/prefetches). Those must be separate
 *    cache entries or an HTML visitor could receive flight data.
 */

export interface KeyOptions {
  /** If set, only these query params are part of the key (others ignored). */
  allowedQuery?: readonly string[];
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_[a-z]+|_ga|ref_src)$/i;

export function normalizePath(pathname: string): string {
  let p = pathname.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

export function normalizeQuery(search: URLSearchParams, opts: KeyOptions = {}): string {
  const allow = opts.allowedQuery ? new Set(opts.allowedQuery) : null;
  const kept: [string, string][] = [];
  for (const [k, v] of search) {
    if (TRACKING.test(k)) continue;
    if (k === "_rsc") continue; // Next.js cache-buster; the rsc header already selects the variant
    if (allow && !allow.has(k)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return new URLSearchParams(kept).toString();
}

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

export function variantOf(headers: HeaderBag): string {
  if (header(headers, "rsc") !== "1") return "html";
  if (header(headers, "next-router-segment-prefetch"))
    return `rsc-seg:${header(headers, "next-router-segment-prefetch")}`;
  if (header(headers, "next-router-prefetch") === "1") return "rsc-prefetch";
  return "rsc";
}

export interface CacheKey {
  key: string;
  path: string;
}

export function cacheKey(rawUrl: string, headers: HeaderBag = {}, opts: KeyOptions = {}): CacheKey {
  const url = new URL(rawUrl, "http://edge.invalid");
  const path = normalizePath(url.pathname);
  const q = normalizeQuery(url.searchParams, opts);
  return { key: `${path}${q ? `?${q}` : ""}#${variantOf(headers)}`, path };
}
