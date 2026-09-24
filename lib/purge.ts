/**
 * Tell the edge cache in front of Next.js that paths changed (the local
 * equivalent of Cloudflare's purge-by-URL API). Best-effort: a failed purge
 * is reported, never thrown, because the ISR revalidation already happened
 * and the edge TTL bounds the staleness anyway.
 */
export interface PurgeResult {
  attempted: boolean;
  ok?: boolean;
  status?: number;
  error?: string;
}

export async function purgeEdge(
  paths: string[],
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PurgeResult> {
  const url = env.CDN_PURGE_URL;
  if (!url) return { attempted: false };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-secret": env.LAB_SECRET ?? "" },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(1000),
    });
    return { attempted: true, ok: res.ok, status: res.status };
  } catch (err) {
    return { attempted: true, ok: false, error: (err as Error).message };
  }
}
