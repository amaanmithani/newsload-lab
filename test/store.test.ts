import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { getStory, isValidSlug, listLatest, peekStory, resetStore, upsertStory } from "../lib/store";
import { freshLab } from "./helpers";

let lab: ReturnType<typeof freshLab>;
beforeEach(() => {
  lab = freshLab();
});

describe("story store", () => {
  it("materialises the seed on first read and counts origin reads", async () => {
    expect(existsSync(lab.dataFile)).toBe(false);
    const s = await getStory("harbour-bridge-closure");
    expect(s?.rev).toBe(1);
    expect(existsSync(lab.dataFile)).toBe(true);
    expect(lab.origin.snapshot().reads).toBe(1);
  });

  it("lists newest first", async () => {
    const list = await listLatest(3);
    expect(list).toHaveLength(3);
    expect(list[0]!.updatedAt >= list[1]!.updatedAt).toBe(true);
  });

  it("validates slugs", async () => {
    expect(isValidSlug("a-b-1")).toBe(true);
    for (const bad of ["A", "a--b", "-a", "../etc", "", 5, "a".repeat(121)]) expect(isValidSlug(bad)).toBe(false);
    expect(await getStory("../etc")).toBeNull();
    expect(await peekStory("Nope")).toBeNull();
    expect(await getStory("missing-story")).toBeNull();
  });

  it("updates bump rev and updatedAt; peek bypasses the origin", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const s = await upsertStory({ slug: "port-cyberattack", headline: "New" }, now);
    expect(s).toMatchObject({ headline: "New", rev: 2, updatedAt: now.toISOString() });
    const before = lab.origin.snapshot().reads;
    expect((await peekStory("port-cyberattack"))?.headline).toBe("New");
    expect(lab.origin.snapshot().reads).toBe(before);
    expect((await listLatest(1))[0]!.slug).toBe("port-cyberattack");
  });

  it("creates new stories and requires a headline", async () => {
    await expect(upsertStory({ slug: "brand-new" })).rejects.toThrow("headline is required");
    const s = await upsertStory({ slug: "brand-new", headline: "Hello" });
    expect(s).toMatchObject({ rev: 1, section: "News", summary: "", body: [] });
  });

  it("serialises concurrent writes without losing revisions", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => upsertStory({ slug: "port-cyberattack", summary: `u${i}` })),
    );
    expect((await peekStory("port-cyberattack"))?.rev).toBe(11);
  });

  it("resets to the seed", async () => {
    await upsertStory({ slug: "port-cyberattack", headline: "x" });
    await resetStore();
    expect((await peekStory("port-cyberattack"))?.rev).toBe(1);
  });

  it("surfaces corrupt data files instead of reseeding", async () => {
    await writeFile(lab.dataFile, "{not json");
    await expect(getStory("port-cyberattack")).rejects.toThrow();
  });
});

describe("loadStory", () => {
  it("delegates to the store", async () => {
    const { loadStory } = await import("../lib/queries");
    expect((await loadStory("port-cyberattack"))?.slug).toBe("port-cyberattack");
  });
});
