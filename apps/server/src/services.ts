import type { EmbeddingModel, LanguageModel } from "@helpos/ai";
import type { AuthStore, Database, PingResult, RetryPolicy } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import { safeFetch } from "@helpos/safe-fetch";
import type { Logger } from "pino";
import { defaultDailyTokenBudget } from "./ai-budget/budget.ts";
import { type GithubApiFactory, octokitGithub } from "./github/github-api.ts";
import type { Fetcher } from "./knowledge/ingest-worker.ts";
import type { EmailTransport } from "./outbound-email/transport.ts";
import type { SecretBox } from "./secrets/secret-box.ts";

/** Where "now" comes from. Tests pass a fixed one; everything else uses the system clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Settings the API and the worker share. One object, so the two can never disagree. */
export interface ServerConfig {
  /** HELPOS_PUBLIC_URL: where the dashboard runs. Links in emails point here. */
  publicUrl: string;
  /** HELPOS_INBOUND_SECRET. Unset, the inbound email endpoint refuses every request. */
  inboundSecret: string | undefined;
  /** The built dashboard to serve at `/`. Unset, only the API is served. */
  webDir: string | undefined;
  /** HELPOS_ALLOW_SHADOW_MODE_OFF. Off by default: shadow mode can't be turned off. */
  allowShadowModeOff: boolean;
  /** Server-wide ceiling on AI tokens per workspace per UTC day; a workspace may have less. */
  dailyTokenBudget: number;
  /** How long a new draft waits before its owner notice is sent. */
  noticeDelaySeconds: number;
  /** How long between GitHub issue state checks while GitHub can't be reached. */
  issueRecheckSeconds: number;
  /** How long a webhook secret read from the database is trusted (see webhook-secrets). */
  webhookSecretCacheMs: number;
  /** Waits before each new try of a knowledge page that failed on a temporary error. */
  fetchRetryDelaysMs: readonly number[];
  /**
   * For tests: one retry policy for every job queue, in place of each job's own, so a failing
   * job gives up in seconds instead of hours.
   */
  jobRetry: RetryPolicy | undefined;
}

export const defaultConfig: ServerConfig = {
  publicUrl: "http://localhost:3000",
  inboundSecret: undefined,
  webDir: undefined,
  allowShadowModeOff: false,
  dailyTokenBudget: defaultDailyTokenBudget,
  // A draft approved within 5 minutes never causes an email.
  noticeDelaySeconds: 300,
  issueRecheckSeconds: 120,
  // Short: it bounds how long another process accepts a rotated or removed secret.
  webhookSecretCacheMs: 15_000,
  fetchRetryDelaysMs: [1_000, 3_000],
  jobRetry: undefined,
};

/** The database calls the API makes outside a tenant (routing mail, tokens, sign-in). */
type ServiceDb = Pick<
  Database,
  "ping" | "withTenant" | "resolveMailbox" | "resolveApiToken" | "listMemberships"
>;

/**
 * Everything the API and the worker are built from, made once. Each role takes what it needs
 * from the same object, so they can't end up with two file stores, two models or two
 * settings. Optional pieces are `undefined` when not configured: the API answers 503 for what
 * needs them, and the worker leaves their jobs waiting in the queue.
 */
export interface Services {
  db: ServiceDb;
  files: FileStore;
  queueReady: () => Promise<PingResult>;
  logger: Pick<Logger, "error" | "warn" | "info">;
  clock: Clock;
  config: ServerConfig;
  /** Drafts replies (worker) and GitHub issues (API). */
  model: LanguageModel | undefined;
  /** Embeds knowledge (worker). Without it, drafts use no knowledge. */
  embeddingModel: EmbeddingModel | undefined;
  /** Sends replies and notices (worker only). */
  transport: EmailTransport | undefined;
  /** Sign-in and password links (API), owner emails for notices (worker). */
  auth: Pick<AuthStore, "sessions" | "setPassword" | "emailsOf"> | undefined;
  /** From HELPOS_ENCRYPTION_KEY. Without it, no GitHub repo can be connected. */
  secretBox: SecretBox | undefined;
  github: GithubApiFactory;
  /** Fetches knowledge URLs. The SSRF-safe fetch; tests point it at a local server. */
  fetch: Fetcher;
  /**
   * Aborted when the server starts shutting down (Server.stopAiCalls), so every AI call in
   * flight stops and settles its budget reservation before the database closes.
   */
  shutdown: AbortSignal;
}

export type ServicesInput = Pick<Services, "db" | "files" | "logger"> &
  Partial<Omit<Services, "db" | "files" | "logger" | "config">> & {
    config?: Partial<ServerConfig>;
    /** HELPOS_GITHUB_API_URL, for the default GitHub client. */
    githubApiUrl?: string;
  };

/** Fills in the defaults: the system clock, the default settings, the real GitHub and fetch. */
export function composeServices(input: ServicesInput): Services {
  return {
    db: input.db,
    files: input.files,
    queueReady:
      input.queueReady ?? (async () => ({ ok: false, error: new Error("queue not configured") })),
    logger: input.logger,
    clock: input.clock ?? systemClock,
    config: { ...defaultConfig, ...input.config },
    model: input.model,
    embeddingModel: input.embeddingModel,
    transport: input.transport,
    auth: input.auth,
    secretBox: input.secretBox,
    github:
      input.github ?? octokitGithub({ baseUrl: input.githubApiUrl ?? "https://api.github.com" }),
    fetch: input.fetch ?? safeFetch,
    shutdown: input.shutdown ?? new AbortController().signal,
  };
}
