import { checkLabSecret } from "@/lib/lab-auth";
import { loopLag, resetLoopLag } from "@/lib/loop-lag";
import { getOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** Origin counters for this Next.js process (reads = slow-origin hits). */
export function GET(): Response {
  const origin = getOrigin();
  return Response.json({ origin: origin.snapshot(), config: origin.config, loopLag: loopLag(), pid: process.pid });
}

/** Reset counters between lab runs. */
export function DELETE(req: Request): Response {
  const auth = checkLabSecret(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  getOrigin().resetStats();
  resetLoopLag();
  return Response.json({ reset: true });
}
