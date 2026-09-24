/**
 * Shared-secret check for the lab's admin endpoints (publish, reset, stats reset).
 * The secret comes from LAB_SECRET; if it is unset every admin call is refused.
 */
export type AuthResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function checkLabSecret(req: Request, env: Record<string, string | undefined> = process.env): AuthResult {
  const expected = env.LAB_SECRET;
  if (!expected) return { ok: false, status: 503, error: "LAB_SECRET is not configured" };
  const given = req.headers.get("x-lab-secret");
  if (given === null || !timingSafeEqual(given, expected)) {
    return { ok: false, status: 401, error: "bad or missing x-lab-secret" };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
