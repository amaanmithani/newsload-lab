// Publish during a spike: readers hammer the hot article at RATE req/s while a
// single editor updates it PUBLISH_AT_S seconds in. Every reader response is
// classified stale (old rev) or fresh (new rev) by its data-rev attribute.
//
// All *_ms trends are "milliseconds since test start", so
//   staleness window = max(stale_start_ms) - publish_ack_ms
// i.e. how long after the CMS acknowledged the publish a reader could still
// START a request and get the old story.
import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { HOT, getArticle, STATUS_THRESHOLDS, summaryWriter, TREND_STATS } from "./lib.js";

const RATE = Number(__ENV.RATE || 300);
const DURATION = __ENV.DURATION || "40s";
const PUBLISH_AT_S = Number(__ENV.PUBLISH_AT_S || 15);
const ADMIN = __ENV.ADMIN_BASE || "http://127.0.0.1:3000";
const SECRET = __ENV.LAB_SECRET || "";

const staleStart = new Trend("stale_start_ms");
const freshStart = new Trend("fresh_start_ms");
const staleAfterPublish = new Counter("stale_after_publish");
const freshResponses = new Counter("fresh_responses");
const staleResponses = new Counter("stale_responses");
const publishSent = new Trend("publish_sent_ms");
const publishAck = new Trend("publish_ack_ms");

export const options = {
  summaryTrendStats: TREND_STATS,
  // Always-true thresholds: they only exist so the summary carries reader-only
  // sub-metrics (excluding setup and the editor's POST).
  thresholds: {
    ...STATUS_THRESHOLDS,
    "http_req_duration{scenario:readers}": ["max>=0"],
    "http_req_failed{scenario:readers}": ["rate>=0"],
    "http_reqs{scenario:readers}": ["count>=0"],
  },
  scenarios: {
    readers: {
      executor: "constant-arrival-rate",
      exec: "reader",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(300, RATE),
      maxVUs: Number(__ENV.MAX_VUS || 1500),
    },
    editor: {
      executor: "per-vu-iterations",
      exec: "editor",
      vus: 1,
      iterations: 1,
      startTime: `${PUBLISH_AT_S}s`,
    },
  },
};

export function setup() {
  const res = http.get(`${ADMIN}/api/stories/${HOT}`);
  if (res.status !== 200) throw new Error(`cannot read current rev: ${res.status}`);
  return { rev0: res.json("rev") };
}

// Test start (epoch ms), derived from whichever scenario we are in.
function testStart() {
  const s = exec.scenario;
  return s.name === "editor" ? s.startTime - PUBLISH_AT_S * 1000 : s.startTime;
}

export function reader(data) {
  const t0 = testStart();
  const started = Date.now() - t0;
  const res = getArticle(HOT);
  const m = res.status === 200 && res.body ? /data-rev="(\d+)"/.exec(res.body) : null;
  check(res, { "status 200": (r) => r.status === 200 });
  if (!m) return;
  if (Number(m[1]) > data.rev0) {
    freshResponses.add(1);
    freshStart.add(started);
  } else {
    staleResponses.add(1);
    staleStart.add(started);
    if (started > PUBLISH_AT_S * 1000) staleAfterPublish.add(1);
  }
}

export function editor() {
  const t0 = testStart();
  publishSent.add(Date.now() - t0);
  const res = http.post(
    `${ADMIN}/api/publish`,
    JSON.stringify({ slug: HOT, headline: `UPDATE: results confirmed (${new Date().toISOString()})` }),
    {
      headers: { "content-type": "application/json", "x-lab-secret": SECRET },
      timeout: "10s",
      tags: { name: "publish" },
    },
  );
  publishAck.add(Date.now() - t0);
  check(res, { "publish 200": (r) => r.status === 200 });
}

export function handleSummary(data) {
  return summaryWriter(data);
}
