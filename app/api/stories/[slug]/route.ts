import { peekStory } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Debug/admin JSON view that bypasses the simulated origin (used by k6 setup to learn the current rev). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const story = await peekStory(slug);
  if (!story) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(story, { headers: { "cache-control": "no-store" } });
}
