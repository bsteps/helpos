import {
  AiConfigError,
  createEmbeddingModel,
  createModel,
  type EmbeddingModel,
  type LanguageModel,
  parseAiConfig,
  parseEmbeddingConfig,
} from "@helpos/ai";
import { brand } from "@helpos/brand";
import { createAuthStore, createDatabase, createJobRunner } from "@helpos/db";
import { createLocalFileStore } from "@helpos/files";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { envSchema } from "./env.ts";
import { octokitGithub } from "./github/github-api.ts";
import { createLogger } from "./logger.ts";
import { createSmtpTransport } from "./outbound-email/transport.ts";
import { createSecretBox } from "./secrets/secret-box.ts";
import { startWorker } from "./worker.ts";

const env = envSchema.parse(process.env);
const logger = createLogger({ level: env.HELPOS_LOG_LEVEL, base: { app: brand.slug } });

const db = createDatabase(env.HELPOS_DATABASE_URL);
const files = createLocalFileStore(env.HELPOS_FILES_DIR);
const inboundSecret = env.HELPOS_INBOUND_SECRET;
if (!inboundSecret) logger.warn("HELPOS_INBOUND_SECRET is not set: inbound email is disabled");

const runner = createJobRunner({
  jobsUrl: env.HELPOS_DATABASE_JOBS_URL,
  db,
  onError: (err) => logger.error({ err }, "job runner error"),
});
const transport = env.HELPOS_SMTP_URL ? createSmtpTransport(env.HELPOS_SMTP_URL) : undefined;
const auth = env.HELPOS_DATABASE_AUTH_URL
  ? createAuthStore(env.HELPOS_DATABASE_AUTH_URL, {
      ...(env.HELPOS_AUTH_SECRET
        ? {
            sessions: {
              secret: env.HELPOS_AUTH_SECRET,
              baseUrl: env.HELPOS_PUBLIC_URL,
              cookiePrefix: brand.slug,
              // Warnings too (e.g. a misconfigured base URL), so a broken sign-in isn't silent.
              log: (level, message) => logger[level](message),
            },
          }
        : {}),
    })
  : undefined;
if (!auth?.sessions) {
  logger.warn(
    "HELPOS_AUTH_SECRET or HELPOS_DATABASE_AUTH_URL is not set: nobody can sign in to the dashboard",
  );
}
await runner.start();
const dailyTokenBudget = env.HELPOS_AI_DAILY_TOKEN_BUDGET;
const model = aiModel();
const secretBox = env.HELPOS_ENCRYPTION_KEY
  ? createSecretBox(env.HELPOS_ENCRYPTION_KEY)
  : undefined;
if (!secretBox) logger.warn("HELPOS_ENCRYPTION_KEY is not set: no GitHub repo can be connected");
const github = octokitGithub({ baseUrl: env.HELPOS_GITHUB_API_URL });
await startWorker({
  runner,
  files,
  logger,
  model,
  embeddingModel: embeddingModel(),
  transport,
  // Only the one function the worker needs, not the whole auth store.
  auth: auth ? { emailsOf: (ids) => auth.emailsOf(ids) } : undefined,
  publicUrl: env.HELPOS_PUBLIC_URL,
  noticeDelaySeconds: env.HELPOS_NOTICE_DELAY_SECONDS,
  dailyTokenBudget,
  secretBox,
  github,
});

const app = createApp({
  db,
  files,
  logger,
  inboundSecret,
  dailyTokenBudget,
  noticeDelaySeconds: env.HELPOS_NOTICE_DELAY_SECONDS,
  allowShadowModeOff: env.HELPOS_ALLOW_SHADOW_MODE_OFF,
  sessions: auth?.sessions ?? undefined,
  // Only the one function the API needs for password links.
  passwords: auth
    ? { setPassword: (token, password) => auth.setPassword(token, password) }
    : undefined,
  publicUrl: env.HELPOS_PUBLIC_URL,
  webDir: env.HELPOS_WEB_DIR,
  model,
  secretBox,
  github,
});
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

/** The embedding model from env, or undefined when it isn't configured (knowledge then waits). */
function embeddingModel(): EmbeddingModel | undefined {
  try {
    return createEmbeddingModel(parseEmbeddingConfig(process.env));
  } catch (error) {
    if (!(error instanceof AiConfigError)) throw error;
    // Unset is a choice; set but invalid is a mistake worth naming. The message names the
    // bad variables, never their values.
    if (process.env.AI_EMBEDDING_PROVIDER) logger.warn(error.message);
    return undefined;
  }
}
