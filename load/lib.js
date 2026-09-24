// Shared helpers for the k6 scenarios. Runs inside k6 (goja), not Node.
import http from "k6/http";
import { Counter } from "k6/metrics";

export const BASE = __ENV.TARGET_BASE || "http://127.0.0.1:3000";
export const PREFIX = __ENV.ARTICLE_PREFIX || "/news/";
export const CONFIG = __ENV.LAB_CONFIG || "isr";
export const HOT = __ENV.HOT_SLUG || "election-results-live";
export const SLUGS = [
  "harbour-bridge-closure",
  "central-bank-holds-rates",
  "wildfire-evacuations-north",
  "transit-strike-talks",
  "election-results-live",
  "heatwave-power-grid",
  "stadium-vote-council",
  "vaccine-trial-results",
  "port-cyberattack",
  "river-flood-warning",
  "tech-layoffs-quarter",
  "championship-final-recap",
];

// Always-true thresholds: they exist only so the summary breaks requests down
// by status (0 = network error / timeout inside k6).
export const STATUS_THRESHOLDS = {
  "http_reqs{status:200}": ["count>=0"],
  "http_reqs{status:0}": ["count>=0"],
  "http_reqs{status:500}": ["count>=0"],
  "http_reqs{status:502}": ["count>=0"],
  "http_reqs{status:503}": ["count>=0"],
};

export const TREND_STATS = ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)", "count"];

const xcache = new Counter("edge_outcomes");

export const PARAMS = { timeout: "10s", tags: { name: "article" } };

/** GET an article and record the edge outcome (x-cache) when present. */
export function getArticle(slug, extraTags) {
  const res = http.get(`${BASE}${PREFIX}${slug}`, Object.assign({}, PARAMS, extraTags ? { tags: extraTags } : {}));
  const outcome = res.headers["X-Cache"];
  if (outcome) xcache.add(1, { outcome });
  return res;
}

export function pickWeighted(hotShare) {
  return Math.random() < hotShare ? HOT : SLUGS[Math.floor(Math.random() * SLUGS.length)];
}

export function summaryWriter(data) {
  const out = __ENV.SUMMARY_OUT;
  const m = data.metrics;
  const d = m.http_req_duration ? m.http_req_duration.values : {};
  const line =
    `[${CONFIG}] reqs=${m.http_reqs ? m.http_reqs.values.count : 0}` +
    ` rate=${m.http_reqs ? m.http_reqs.values.rate.toFixed(1) : 0}/s` +
    ` p50=${(d["p(50)"] || 0).toFixed(1)}ms p95=${(d["p(95)"] || 0).toFixed(1)}ms p99=${(d["p(99)"] || 0).toFixed(1)}ms` +
    ` failed=${m.http_req_failed ? (m.http_req_failed.values.rate * 100).toFixed(2) : 0}%` +
    ` dropped=${m.dropped_iterations ? m.dropped_iterations.values.count : 0}\n`;
  const files = { stdout: line };
  if (out) files[out] = JSON.stringify(data, null, 1) + "\n";
  return files;
}
