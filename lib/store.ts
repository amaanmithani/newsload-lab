import { promises as fs } from "node:fs";
import path from "node:path";
import { getOrigin } from "./origin";

export interface Story {
  slug: string;
  headline: string;
  summary: string;
  section: string;
  body: string[];
  publishedAt: string;
  updatedAt: string;
  /** Monotonic revision, bumped on every publish. Rendered as data-rev so load tests can detect staleness. */
  rev: number;
}

export interface StoryUpdate {
  slug: string;
  headline?: string;
  summary?: string;
  section?: string;
  body?: string[];
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length <= 120 && SLUG_RE.test(slug);
}

function dataFile(): string {
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.DATA_FILE ?? path.join(process.cwd(), ".data", "stories.json"),
  );
}

function seedFile(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.SEED_FILE ?? path.join(process.cwd(), "data", "seed.json"));
}

async function readJson(file: string): Promise<Story[]> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Story[];
}

async function writeAtomic(file: string, stories: Story[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(stories, null, 2) + "\n");
  await fs.rename(tmp, file);
}

/** Raw load, no simulated latency. Falls back to (and materialises) the seed on first use. */
async function load(): Promise<Story[]> {
  try {
    return await readJson(dataFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const seed = await readJson(seedFile());
    await writeAtomic(dataFile(), seed);
    return seed;
  }
}

function byNewest(a: Story, b: Story): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug);
}

export async function listLatest(limit = 20): Promise<Story[]> {
  return getOrigin().query("read", async () => (await load()).sort(byNewest).slice(0, limit));
}

export async function getStory(slug: string): Promise<Story | null> {
  if (!isValidSlug(slug)) return null;
  return getOrigin().query("read", async () => (await load()).find((s) => s.slug === slug) ?? null);
}

/** Admin read that bypasses the simulated origin (not counted, no latency). */
export async function peekStory(slug: string): Promise<Story | null> {
  if (!isValidSlug(slug)) return null;
  return (await load()).find((s) => s.slug === slug) ?? null;
}

// Writes are serialised so concurrent publishes cannot lose updates.
let writeChain: Promise<unknown> = Promise.resolve();

export function upsertStory(update: StoryUpdate, now: Date = new Date()): Promise<Story> {
  const run = async (): Promise<Story> => {
    const stories = await load();
    const ts = now.toISOString();
    const i = stories.findIndex((s) => s.slug === update.slug);
    let story: Story;
    if (i >= 0) {
      const prev = stories[i]!;
      story = {
        ...prev,
        headline: update.headline ?? prev.headline,
        summary: update.summary ?? prev.summary,
        section: update.section ?? prev.section,
        body: update.body ?? prev.body,
        updatedAt: ts,
        rev: prev.rev + 1,
      };
      stories[i] = story;
    } else {
      if (!update.headline) throw new Error("headline is required for a new story");
      story = {
        slug: update.slug,
        headline: update.headline,
        summary: update.summary ?? "",
        section: update.section ?? "News",
        body: update.body ?? [],
        publishedAt: ts,
        updatedAt: ts,
        rev: 1,
      };
      stories.push(story);
    }
    await writeAtomic(dataFile(), stories);
    return story;
  };
  const result = writeChain.then(() => getOrigin().query("write", run));
  writeChain = result.catch(() => undefined);
  return result;
}

/** Restore the seed data set (used between lab runs). */
export async function resetStore(): Promise<void> {
  await writeAtomic(dataFile(), await readJson(seedFile()));
}
