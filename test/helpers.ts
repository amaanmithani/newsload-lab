import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Origin, setOrigin } from "../lib/origin";

/** Point the store at a fresh temp file and use a zero-latency origin. */
export function freshLab(): { dataFile: string; origin: Origin } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "newsload-"));
  const dataFile = path.join(dir, "stories.json");
  process.env.DATA_FILE = dataFile;
  process.env.SEED_FILE = path.resolve(import.meta.dirname, "../data/seed.json");
  const origin = new Origin({ latencyMs: 0, maxConcurrency: 4, queueTimeoutMs: 1000 });
  setOrigin(origin);
  return { dataFile, origin };
}
