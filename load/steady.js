// Steady load: a normal news day. Constant arrival rate spread over all
// articles (25% on the lead story).
import { check } from "k6";
import { getArticle, pickWeighted, STATUS_THRESHOLDS, summaryWriter, TREND_STATS } from "./lib.js";

const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || "30s";

export const options = {
  summaryTrendStats: TREND_STATS,
  thresholds: STATUS_THRESHOLDS,
  discardResponseBodies: true,
  scenarios: {
    steady: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(200, RATE),
      maxVUs: Number(__ENV.MAX_VUS || 600),
    },
  },
};

export default function () {
  const res = getArticle(pickWeighted(0.25));
  check(res, { "status 200": (r) => r.status === 200 });
}

export const handleSummary = summaryWriter;
