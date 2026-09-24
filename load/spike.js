// Breaking news: arrivals ramp from a quiet baseline to PEAK_RATE req/s in
// RAMP, hold, then fall away. 90% of requests hit the one hot article.
import { check } from "k6";
import { getArticle, pickWeighted, STATUS_THRESHOLDS, summaryWriter, TREND_STATS } from "./lib.js";

const BASE_RATE = Number(__ENV.BASE_RATE || 50);
const PEAK = Number(__ENV.PEAK_RATE || 1500);

export const options = {
  summaryTrendStats: TREND_STATS,
  thresholds: STATUS_THRESHOLDS,
  discardResponseBodies: true,
  scenarios: {
    spike: {
      executor: "ramping-arrival-rate",
      startRate: BASE_RATE,
      timeUnit: "1s",
      preAllocatedVUs: Number(__ENV.PRE_VUS || 200),
      maxVUs: Number(__ENV.MAX_VUS || 1500),
      stages: [
        { target: BASE_RATE, duration: __ENV.BASELINE || "10s" },
        { target: PEAK, duration: __ENV.RAMP || "10s" },
        { target: PEAK, duration: __ENV.HOLD || "20s" },
        { target: 0, duration: __ENV.COOLDOWN || "5s" },
      ],
    },
  },
};

export default function () {
  const res = getArticle(pickWeighted(0.9));
  check(res, { "status 200": (r) => r.status === 200 });
}

export const handleSummary = summaryWriter;
