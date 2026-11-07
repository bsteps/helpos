import { AiConfigError, createModel, type LanguageModel, parseAiConfig } from "@helpos/ai";
import { brand } from "@helpos/brand";
import { createAuthStore, createDatabase, createJobRunner } from "@helpos/db";
import { createLocalFileStore } from "@helpos/files";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp, errorSummary } from "./app.ts";
import { envSchema } from "./env.ts";
import { createSmtpTransport } from "./outbound-email/transport.ts";
import { startWorker } from "./worker.ts";

const env = envSchema.parse(process.env);
const logger = pino({ level: env.HELPOS_LOG_LEVEL, base: { app: brand.slug } });

const db = createDatabase(env.HELPOS_DATABASE_URL);
const files = createLocalFileStore(env.HELPOS_FILES_DIR);
const inboundSecret = env.HELPOS_INBOUND_SECRET;
if (!inboundSecret) logger.warn("HELPOS_INBOUND_SECRET is not set: inbound email is disabled");

const runner = createJobRunner({
  jobsUrl: env.HELPOS_DATABASE_JOBS_URL,
  db,
  onError: (err) => logger.error({ err: errorSummary(err) }, "job runner error"),
});
const transport = env.HELPOS_SMTP_URL ? createSmtpTransport(env.HELPOS_SMTP_URL) : undefined;
const auth = env.HELPOS_DATABASE_AUTH_URL
  ? createAuthStore(env.HELPOS_DATABASE_AUTH_URL)
  : undefined;
await runner.start();
const dailyTokenBudget = env.HELPOS_AI_DAILY_TOKEN_BUDGET;
await startWorker({
  runner,
  files,
  logger,
  model: aiModel(),
  transport,
  auth,
  publicUrl: env.HELPOS_PUBLIC_URL,
  dailyTokenBudget,
});

const app = createApp({ db, files, logger, inboundSecret, dailyTokenBudget });
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
    await runner.stop();
    transport?.close();
    await auth?.close();
    await db.close();
  } catch (err) {
    logger.error({ err }, "shutdown failed");
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

/** The AI model from env, or undefined when AI isn't configured (drafting then waits). */
function aiModel(): LanguageModel | undefined {
  try {
    return createModel(parseAiConfig(process.env));
  } catch (error) {
    if (error instanceof AiConfigError) return undefined;
    throw error;
  }
}
