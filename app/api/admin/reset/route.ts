import { revalidatePath } from "next/cache";
import { checkLabSecret } from "@/lib/lab-auth";
import { getOrigin } from "@/lib/origin";
import { resetStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Restore seed data, invalidate every ISR page and zero the origin counters. */
export async function POST(req: Request): Promise<Response> {
  const auth = checkLabSecret(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  await resetStore();
  revalidatePath("/", "layout");
  getOrigin().resetStats();
  return Response.json({ reset: true });
}
