import { createEmbeddingModel, createModel } from "@helpos/ai";
import { brand } from "@helpos/brand";
import {
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  type JobRunner,
  type JobRunnerOptions,
} from "@helpos/db";
import { createLocalFileStore } from "@helpos/files";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { type AppOptions, createApp } from "./app.ts";
import type { Env } from "./env.ts";
import { jobs } from "./jobs.ts";
import { withoutRequestId } from "./logger.ts";
import { createSmtpTransport } from "./outbound-email/transport.ts";
import { composeServices, type Services, type ServicesInput } from "./services.ts";
import { startWorker } from "./worker.ts";

export type ServerInput = Omit<ServicesInput, "db" | "shutdown"> & {
  /** The app-role database. The job runner reaches tenant data only through its withTenant(). */
  db: Database;
  /** The jobs role (owner of `pgboss`). */
  jobsUrl: string;
  /** The job runner's errors, with queue and job ID when it has them. Default: logged. */
  onJobError?: JobRunnerOptions["onError"];
  pollingIntervalSeconds?: number;
};

/**
 * The whole server, built once from one set of services. Each role takes what it needs from it:
 * the API (web role) and the worker can never get different settings, models or file stores.
 * Both run in one process for the MVP; #18 runs each from its own entry point.
 */
export interface Server {
  services: Services;
  runner: JobRunner;
  /** The web role: the API, and the dashboard when `webDir` is set. */
  app(options?: AppOptions): OpenAPIHono;
  /** The worker role: starts pg-boss, creates every queue and works them. */
  startWorker(): Promise<void>;
  /**
   * The first step of a shutdown: aborts every AI call in flight, in jobs and requests. Each
   * settles its budget reservation (its cost unknown, so all of it counts) and fails: a job is
   * tried again after the restart. Call it before anything waits for work to finish.
   */
  stopAiCalls(): void;
  /** Stops AI calls, then the worker, waiting for its jobs (and their settles) to end. */
  stopWorker(): Promise<void>;
}

export function composeServer(input: ServerInput): Server {
  const stopping = new AbortController();
  const services = composeServices({ ...input, shutdown: stopping.signal });
  const stopAiCalls = () => {
    if (!stopping.signal.aborted) stopping.abort(new Error("the server is shutting down"));
  };
  const onJobError: JobRunnerOptions["onError"] =
    input.onJobError ??
    ((err, context) => services.logger.error({ err, ...context }, "job runner error"));
  const runner = createJobRunner({
    jobsUrl: input.jobsUrl,
    db: input.db,
    onError: (...args) => withoutRequestId(() => onJobError(...args)),
    ...(input.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: input.pollingIntervalSeconds }),
  });
  services.queueReady = () => runner.ready(jobs.map((job) => job.queue));
  return {
    services,
    runner,
    app: (options) => createApp(services, options),
    startWorker: async () => {
      await runner.start();
      await startWorker(services, runner);
    },
    stopAiCalls,
    stopWorker: async () => {
      stopAiCalls();
      await runner.stop();
    },
  };
}

/** The server as configured by the environment, and how to close what it opened. */
export function serverFromEnv(env: Env, logger: Logger): Server & { close(): Promise<void> } {
  const db = createDatabase(env.HELPOS_DATABASE_URL);
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

  if (!env.HELPOS_INBOUND_SECRET) {
    logger.warn("HELPOS_INBOUND_SECRET is not set: inbound email is disabled");
  }
  if (!auth?.sessions) {
    logger.warn(
      "HELPOS_AUTH_SECRET or HELPOS_DATABASE_AUTH_URL is not set: nobody can sign in to the dashboard",
    );
  }

  const server = composeServer({
    db,
    jobsUrl: env.HELPOS_DATABASE_JOBS_URL,
    files: createLocalFileStore(env.HELPOS_FILES_DIR),
    logger,
    config: {
      publicUrl: env.HELPOS_PUBLIC_URL,
      inboundSecret: env.HELPOS_INBOUND_SECRET,
      webDir: env.HELPOS_WEB_DIR,
      allowShadowModeOff: env.HELPOS_ALLOW_SHADOW_MODE_OFF,
      dailyTokenBudget: env.HELPOS_AI_DAILY_TOKEN_BUDGET,
      noticeDelaySeconds: env.HELPOS_NOTICE_DELAY_SECONDS,
    },
    model: env.ai ? createModel(env.ai) : undefined,
    embeddingModel: env.embedding ? createEmbeddingModel(env.embedding) : undefined,
    transport,
    auth,
  });
  return {
    ...server,
    close: async () => {
      await server.stopWorker();
      transport?.close();
      await auth?.close();
      await db.close();
    },
  };
}
