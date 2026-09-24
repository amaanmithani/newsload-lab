import { revalidatePath } from "next/cache";
import { checkLabSecret } from "@/lib/lab-auth";
import { purgeEdge } from "@/lib/purge";
import { isValidSlug, upsertStory, type StoryUpdate } from "@/lib/store";

export const dynamic = "force-dynamic";

function bad(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Publish or update a story, then revalidate on demand:
 *   POST /api/publish  {slug, headline?, summary?, section?, body?}
 * 1. write to the store (bumps rev)
 * 2. revalidatePath for the article and the home page (ISR)
 * 3. purge the same paths at the edge proxy, if CDN_PURGE_URL is set
 */
export async function POST(req: Request): Promise<Response> {
  const auth = checkLabSecret(req);
  if (!auth.ok) return bad(auth.status, auth.error);

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return bad(400, "body must be JSON");
  }
  if (typeof input !== "object" || input === null) return bad(400, "body must be an object");
  const { slug, headline, summary, section, body } = input as Record<string, unknown>;
  if (!isValidSlug(slug)) return bad(400, "slug must be kebab-case [a-z0-9-]");
  for (const [k, v] of Object.entries({ headline, summary, section })) {
    if (v !== undefined && (typeof v !== "string" || v.length > 500))
      return bad(400, `${k} must be a string (<=500 chars)`);
  }
  if (body !== undefined && !isStringArray(body)) return bad(400, "body must be an array of strings");

  const update: StoryUpdate = {
    slug,
    headline: headline as string | undefined,
    summary: summary as string | undefined,
    section: section as string | undefined,
    body: body as string[] | undefined,
  };

  let story;
  try {
    story = await upsertStory(update);
  } catch (err) {
    const msg = (err as Error).message;
    return bad(msg.includes("required") ? 400 : 503, msg);
  }

  const paths = [`/news/${slug}`, "/"];
  for (const p of paths) revalidatePath(p);
  const purge = await purgeEdge(paths);

  return Response.json({ story, revalidated: paths, purge }, { status: 200 });
}
