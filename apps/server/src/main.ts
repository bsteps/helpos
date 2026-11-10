import { brand } from "@helpos/brand";
import { serve } from "@hono/node-server";
import { envSchema } from "./env.ts";
import { createLogger } from "./logger.ts";
import { serverFromEnv } from "./server.ts";

const env = envSchema.parse(process.env);
const logger = createLogger({ level: env.HELPOS_LOG_LEVEL, base: { app: brand.slug } });

// Both roles in one process for the MVP (#18 splits them), built from the same services.
const helpos = serverFromEnv(env, logger);
await helpos.startWorker();
const app = helpos.app();
const server = serve({ fetch: app.fetch, port: env.HELPOS_PORT }, (info) => {
  logger.info(
    { port: info.port },
    `${brand.name} server listening on http://localhost:${info.port}`,
  );
});

// Long requests must not block a stop forever (e.g. `docker stop` waits 10 s, then kills).
const shutdownTimeoutMs = 8_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second Ctrl+C must not close everything twice
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  setTimeout(() => {
    logger.error({ timeoutMs: shutdownTimeoutMs }, "shutdown timed out, forcing exit");
    process.exit(1);
  }, shutdownTimeoutMs).unref();
  // Stop accepting connections and let in-flight requests finish before closing the pool.
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await helpos.close();
  } catch (err) {
    logger.error({ err }, "shutdown failed");
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
