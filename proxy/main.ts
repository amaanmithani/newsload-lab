import { EdgeCache } from "./edge-cache.ts";
import { createEdgeServer, httpUpstream } from "./server.ts";

const env = process.env;
const port = Number(env.EDGE_PORT ?? 8080);
const origin = env.EDGE_ORIGIN ?? "http://127.0.0.1:3000";
const { upstream, agent } = httpUpstream({ origin, maxSockets: Number(env.EDGE_MAX_SOCKETS ?? 256) });

const cache = new EdgeCache({
  upstream,
  maxEntries: Number(env.EDGE_MAX_ENTRIES ?? 5000),
  maxSwrMs: Number(env.EDGE_MAX_SWR_S ?? 60) * 1000,
  defaultSieMs: Number(env.EDGE_DEFAULT_SIE_S ?? 300) * 1000,
  hitForPassMs: Number(env.EDGE_HIT_FOR_PASS_S ?? 10) * 1000,
  keyOptions: env.EDGE_ALLOWED_QUERY ? { allowedQuery: env.EDGE_ALLOWED_QUERY.split(",") } : {},
});

const purgeMode = env.EDGE_PURGE_MODE === "soft" ? "soft" : "hard";
const server = createEdgeServer({ cache, secret: env.LAB_SECRET, purgeMode });
server.keepAliveTimeout = 65_000;
server.listen(port, "127.0.0.1", () => {
  console.log(`newsload-edge listening on http://127.0.0.1:${port} -> ${origin} (purge=${purgeMode})`);
});

const shutdown = () => {
  server.close();
  agent.destroy();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
