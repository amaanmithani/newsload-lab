// Thundering herd: HERD virtual users request the same cold (just-published,
// never cached) article at the same instant. Measures how many of them reach
// the slow origin: every one (origin only), whatever Next.js lets through
// (ISR), or one (edge single-flight).
import { check } from "k6";
import { getArticle, HOT, STATUS_THRESHOLDS, summaryWriter, TREND_STATS } from "./lib.js";

const HERD = Number(__ENV.HERD || 1000);

export const options = {
  summaryTrendStats: TREND_STATS,
  thresholds: STATUS_THRESHOLDS,
  discardResponseBodies: true,
  scenarios: {
    herd: {
      executor: "per-vu-iterations",
      vus: HERD,
      iterations: 1,
      maxDuration: "30s",
    },
  },
};

export default function () {
  const res = getArticle(HOT);
  check(res, { "status 200": (r) => r.status === 200 });
}

export const handleSummary = summaryWriter;
