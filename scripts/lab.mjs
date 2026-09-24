#!/usr/bin/env node
// Orchestrates one lab scenario across the three configurations:
//
//   origin : k6 -> Next.js /live/<slug>   (force-dynamic, every request hits the slow origin)
//   isr    : k6 -> Next.js /news/<slug>   (ISR, revalidate = 30 s, on-demand revalidatePath)
//   edge   : k6 -> edge proxy -> Next.js /news/<slug>  (SWR + single-flight + purge on publish)
//
// For each configuration it starts fresh server processes, resets the data
// set, warms caches, zeroes counters, runs k6, then collects origin/edge
// counters and machine load, and kills every process it started.
//
// Usage: node scripts/lab.mjs <steady|spike|publish> [origin,isr,edge]
// Env overrides: RATE, PEAK_RATE, DURATION, MAX_VUS, K6_BIN, LOAD_ABORT, ...
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCENARIOS = ["steady", "spike", "publish", "herd"];
const scenario = process.argv[2];
const configs = (process.argv[3] ?? "origin,isr,edge").split(",");
if (!SCENARIOS.includes(scenario)) {
  console.error(`usage: node scripts/lab.mjs <${SCENARIOS.join("|")}> [origin,isr,edge]`);
  process.exit(2);
}

const K6 =
  process.env.K6_BIN ??
  (existsSync(path.join(os.homedir(), ".local/bin/k6")) ? path.join(os.homedir(), ".local/bin/k6") : "k6");
const NEXT_PORT = 3000;
const EDGE_PORT = 8080;
const NEXT = `http://127.0.0.1:${NEXT_PORT}`;
const EDGE = `http://127.0.0.1:${EDGE_PORT}`;
const SECRET = "lab-local-secret";
const HOT = "election-results-live";
const CPUS = os.cpus().length;
// Abort a run if the 1-minute load average exceeds this (machine is shared).
const LOAD_ABORT = Number(process.env.LOAD_ABORT ?? CPUS * 5);
const LOAD_START_MAX = Number(process.env.LOAD_START_MAX ?? CPUS * 3);

const ORIGIN_ENV = {
  ORIGIN_LATENCY_MS: process.env.ORIGIN_LATENCY_MS ?? "120",
  ORIGIN_MAX_CONCURRENCY: process.env.ORIGIN_MAX_CONCURRENCY ?? "16",
  ORIGIN_QUEUE_TIMEOUT_MS: process.env.ORIGIN_QUEUE_TIMEOUT_MS ?? "2000",
};

const TARGETS = {
  origin: { base: NEXT, prefix: "/live/" },
  isr: { base: NEXT, prefix: "/news/" },
  edge: { base: EDGE, prefix: "/news/" },
};

const children = new Set();

function startProcess(name, cmd, args, env, logFile) {
  const fd = openSync(logFile, "w");
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    detached: true, // own process group, so we can kill any grandchildren too
  });
  child.labName = name;
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const timeout = sleep(5000).then(() => "timeout");
  if ((await Promise.race([exited, timeout])) === "timeout") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await exited;
  }
}

async function stopAll() {
  await Promise.all([...children].map(stopProcess));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.error(`\n${sig}: stopping lab processes`);
    await stopAll();
    process.exit(130);
  });
}

async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

const admin = (method, url, body) =>
  fetch(url, {
    method,
    headers: { "x-lab-secret": SECRET, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${await r.text()}`);
    return r.json();
  });

async function currentRev(slug) {
  return (await (await fetch(`${NEXT}/api/stories/${slug}`)).json()).rev;
}

/** Request each article until the target serves the current revision (ISR/edge caches hot and fresh). */
async function warm(target) {
  const slugs = JSON.parse(readFileSync(path.join(ROOT, "data", "seed.json"), "utf8")).map((s) => s.slug);
  for (const slug of slugs) {
    const want = await currentRev(slug);
    for (let i = 0; i < 20; i++) {
      const body = await (await fetch(`${target.base}${target.prefix}${slug}`)).text();
      const m = /data-rev="(\d+)"/.exec(body);
      if (m && Number(m[1]) === want) break;
      await sleep(200);
    }
  }
}

function scenarioEnv(config) {
  const t = TARGETS[config];
  const base = {
    TARGET_BASE: t.base,
    ARTICLE_PREFIX: t.prefix,
    LAB_CONFIG: config,
    HOT_SLUG: HOT,
    ADMIN_BASE: NEXT,
    LAB_SECRET: SECRET,
  };
  const passthrough = [
    "RATE",
    "PEAK_RATE",
    "BASE_RATE",
    "DURATION",
    "MAX_VUS",
    "PRE_VUS",
    "BASELINE",
    "RAMP",
    "HOLD",
    "COOLDOWN",
    "PUBLISH_AT_S",
    "HERD",
  ];
  for (const k of passthrough) if (process.env[k]) base[k] = process.env[k];
  return base;
}

function machineInfo() {
  let k6Version = "unknown";
  try {
    k6Version = execFileSync(K6, ["version"], { encoding: "utf8" }).trim();
  } catch {
    /* k6 missing */
  }
  let osVersion = `${os.type()} ${os.release()}`;
  try {
    osVersion = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim().replace(/^/, "macOS ");
  } catch {
    /* not macOS */
  }
  const pkg = (p) => {
    try {
      return JSON.parse(
        execFileSync("node", ["-p", `JSON.stringify(require('${p}/package.json').version)`], {
          cwd: ROOT,
          encoding: "utf8",
        }),
      );
    } catch {
      return "unknown";
    }
  };
  return {
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: CPUS,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    os: osVersion,
    arch: os.arch(),
    node: process.version,
    next: pkg("next"),
    k6: k6Version,
    note: "k6, the edge proxy and Next.js all ran on this one machine, alongside unrelated background jobs.",
  };
}

async function runK6(config, outDir) {
  const script = path.join(ROOT, "load", `${scenario}.js`);
  const summary = path.join(outDir, `${config}.k6.json`);
  const env = { ...scenarioEnv(config), SUMMARY_OUT: summary, K6_NO_USAGE_REPORT: "true" };
  const k6 = spawn(K6, ["run", "--quiet", "--no-color", script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let peakLoad = os.loadavg()[0];
  let aborted = null;
  const monitor = setInterval(() => {
    const l = os.loadavg()[0];
    peakLoad = Math.max(peakLoad, l);
    if (l > LOAD_ABORT && !aborted) {
      aborted = `1-min load average ${l.toFixed(1)} exceeded LOAD_ABORT=${LOAD_ABORT}`;
      console.error(`!! ${aborted}; stopping k6 early`);
      k6.kill("SIGINT"); // k6 still writes its summary on SIGINT
    }
  }, 1000);
  const code = await new Promise((r) => k6.on("exit", (c) => r(c)));
  clearInterval(monitor);
  return { code, peakLoad, aborted, summary, env };
}

async function runConfig(config, outDir) {
  if (!(await portFree(NEXT_PORT)) || !(await portFree(EDGE_PORT))) {
    throw new Error(`port ${NEXT_PORT} or ${EDGE_PORT} is busy; stop whatever is listening there first`);
  }
  const dataFile = path.join(ROOT, ".data", "lab-stories.json");
  const nextEnv = {
    ...ORIGIN_ENV,
    NODE_ENV: "production",
    LAB_SECRET: SECRET,
    DATA_FILE: dataFile,
    ...(config === "edge" ? { CDN_PURGE_URL: `${EDGE}/__edge/purge` } : {}),
  };
  const logDir = path.join(ROOT, ".lab-tmp");
  mkdirSync(logDir, { recursive: true });
  const next = startProcess(
    "next",
    path.join(ROOT, "node_modules/.bin/next"),
    ["start", "-p", String(NEXT_PORT), "-H", "127.0.0.1"],
    nextEnv,
    path.join(logDir, `${scenario}-${config}.next.log`),
  );
  let edge = null;
  try {
    await waitFor(`${NEXT}/api/stats`);
    if (config === "edge") {
      edge = startProcess(
        "edge",
        process.execPath,
        ["proxy/main.ts"],
        { LAB_SECRET: SECRET, EDGE_PORT: String(EDGE_PORT), EDGE_ORIGIN: NEXT },
        path.join(logDir, `${scenario}-${config}.edge.log`),
      );
      await waitFor(`${EDGE}/__edge/health`);
    }
    await admin("POST", `${NEXT}/api/admin/reset`);
    // The herd scenario needs a cold hot article; everything else starts warm.
    if (scenario !== "herd") await warm(TARGETS[config]);
    await admin("DELETE", `${NEXT}/api/stats`);
    if (edge) await admin("DELETE", `${EDGE}/__edge/stats`);

    const loadBefore = os.loadavg();
    const startedAt = new Date().toISOString();
    console.log(`\n== ${scenario} / ${config}: load avg before ${loadBefore.map((l) => l.toFixed(2)).join(" ")}`);
    const k6 = await runK6(config, outDir);
    const finishedAt = new Date().toISOString();

    const nextStats = await (await fetch(`${NEXT}/api/stats`)).json();
    const edgeStats = edge ? await (await fetch(`${EDGE}/__edge/stats`)).json() : null;
    const record = {
      scenario,
      config,
      target: TARGETS[config],
      startedAt,
      finishedAt,
      k6ExitCode: k6.code,
      aborted: k6.aborted,
      loadAvg: { before: loadBefore, peak1m: k6.peakLoad, after: os.loadavg() },
      origin: nextStats.origin,
      nextEventLoopLag: nextStats.loopLag,
      originConfig: nextStats.config,
      edge: edgeStats,
      k6Env: Object.fromEntries(Object.entries(k6.env).filter(([k]) => !["LAB_SECRET", "SUMMARY_OUT"].includes(k))),
      k6Summary: path.relative(ROOT, k6.summary),
    };
    writeFileSync(path.join(outDir, `${config}.lab.json`), JSON.stringify(record, null, 2) + "\n");
    console.log(
      `   origin reads=${nextStats.origin.reads} rejected=${nextStats.origin.rejected}` +
        (edgeStats ? ` edge upstreamFetches=${edgeStats.upstreamFetches}` : ""),
    );
  } finally {
    if (edge) await stopProcess(edge);
    await stopProcess(next);
  }
}

async function main() {
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    console.log("No production build found; running `next build` first.");
    execFileSync(path.join(ROOT, "node_modules/.bin/next"), ["build"], { cwd: ROOT, stdio: "inherit" });
  }
  const outDir = path.join(ROOT, "results", scenario);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(ROOT, "results", "machine.json"), JSON.stringify(machineInfo(), null, 2) + "\n");

  for (const config of configs) {
    if (!TARGETS[config]) throw new Error(`unknown config ${config}`);
    for (let i = 0; os.loadavg()[0] > LOAD_START_MAX; i++) {
      if (i >= Number(process.env.LOAD_WAIT_S ?? 120) / 10)
        throw new Error(`load average stayed above ${LOAD_START_MAX}; not starting ${config}`);
      console.log(`load average ${os.loadavg()[0].toFixed(1)} > ${LOAD_START_MAX}, waiting...`);
      await sleep(10_000);
    }
    await runConfig(config, outDir);
    await sleep(Number(process.env.COOLDOWN_S ?? 8) * 1000);
  }
  console.log(`\nResults in results/${scenario}/. Render README tables with: npm run results:render`);
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(stopAll);
