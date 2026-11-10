import type { LanguageModel } from "@helpos/ai";
import { brand } from "@helpos/brand";
import type { AuthStore, Database, SessionAuth } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";
import { defaultDailyTokenBudget } from "./ai-budget/budget.ts";
import { registerAiUsageRoute } from "./ai-budget/routes.ts";
import {
  type Authenticate,
  authenticateRequest,
  callerResolver,
  refuseAll,
} from "./auth/principal.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { humanSessions } from "./auth/session.ts";
import { registerDraftRoutes } from "./drafts/routes.ts";
import { type GithubApiFactory, octokitGithub } from "./github/github-api.ts";
import { registerGithubRoutes } from "./github/routes.ts";
import { registerInboundEmail } from "./inbound-email/route.ts";
import { registerKnowledgeRoutes } from "./knowledge/routes.ts";
import type { SecretBox } from "./secrets/secret-box.ts";
import { registerStatsRoutes } from "./stats/routes.ts";
import { registerTicketRoutes } from "./tickets/routes.ts";
import { agentTokens } from "./tokens/authenticate.ts";
import { registerTokenRoutes } from "./tokens/routes.ts";
import { registerDashboard } from "./web/dashboard.ts";
import { registerShadowModeRoutes } from "./workspaces/shadow-mode-routes.ts";

export interface AppDeps {
  db: Pick<
    Database,
    "ping" | "withTenant" | "resolveMailbox" | "resolveApiToken" | "listMemberships"
  >;
  files: FileStore;
  logger: Pick<Logger, "error" | "warn" | "info">;
  /** HELPOS_INBOUND_SECRET. When unset, the inbound email endpoint refuses every request. */
  inboundSecret: string | undefined;
  /**
   * Human sign-in (session cookies). Without it, sign-in answers 503 and only agent tokens
   * work. Needs HELPOS_AUTH_SECRET and HELPOS_DATABASE_AUTH_URL.
   */
  sessions?: SessionAuth | undefined;
  /** Password setup links. Without it, setting a password answers 503. */
  passwords?: Pick<AuthStore, "setPassword"> | undefined;
  /** HELPOS_PUBLIC_URL: where the dashboard runs. Browser writes from other origins are refused. */
  publicUrl?: string;
  /** The built dashboard to serve at `/`. Without it, the server serves only the API. */
  webDir?: string | undefined;
  /**
   * Resolves API callers. Defaults to agent tokens (`hos_…`) and, when `sessions` is set,
   * human session cookies. Tests replace it to act as a signed-in human.
   */
  authenticate?: Authenticate;
  /** Reported by the usage endpoint. The worker enforces it. */
  dailyTokenBudget?: number;
  /** For tests: the clock "today" is read from. */
  now?: () => Date;
  /** How long a new draft waits before its owner notice is sent. */
  noticeDelaySeconds?: number;
  /** HELPOS_ALLOW_SHADOW_MODE_OFF. Off by default: shadow mode can't be turned off. */
  allowShadowModeOff?: boolean;
  /** Drafts GitHub issues from tickets. Without it, issues are written by hand. */
  model?: LanguageModel | undefined;
  /** From HELPOS_ENCRYPTION_KEY. Without it, no GitHub repo can be connected. */
  secretBox?: SecretBox | undefined;
  /** Talks to GitHub. Defaults to Octokit against api.github.com; tests pass a fake. */
  github?: GithubApiFactory;
  /** For tests: how long before a failed GitHub issue state check is tried again. */
  issueRecheckSeconds?: number;
  /** For tests: how long a webhook secret read from the database is trusted. */
  webhookSecretCacheMs?: number;
}

export function createApp({
  db,
  files,
  logger,
  inboundSecret,
  sessions,
  passwords,
  publicUrl = "http://localhost:3000",
  webDir,
  authenticate,
  dailyTokenBudget = defaultDailyTokenBudget,
  now,
  noticeDelaySeconds,
  allowShadowModeOff = false,
  model,
  secretBox,
  github = octokitGithub({ baseUrl: "https://api.github.com" }),
  issueRecheckSeconds,
  webhookSecretCacheMs,
}: AppDeps): OpenAPIHono {
  const trustedOrigin = new URL(publicUrl).origin;
  const resolve =
    authenticate ??
    authenticateRequest({
      tokens: agentTokens(db),
      session: sessions ? humanSessions({ sessions, db, trustedOrigin }) : refuseAll,
    });
  const app = new OpenAPIHono();
  // Every response carries X-Request-Id, and audit events record it.
  app.use("*", requestId());
  // Routes authenticate their own callers (see apiRoute()); this says how.
  app.use("*", callerResolver(resolve));

  // Liveness + readiness in one: the server is only useful if it can reach Postgres.
  // The body stays minimal on purpose, so it reveals nothing about the setup.
  app.get("/health", async (c) => {
    const ping = await db.ping();
    if (ping.ok) return c.json({ status: "ok", database: "ok" }, 200);
    // The details go to the log, never to the (unauthenticated) response.
    logger.error({ err: ping.error }, "health check: database unreachable");
    return c.json({ status: "error", database: "unreachable" }, 503);
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "apiAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "An agent token: `Authorization: Bearer hos_…`, created through `POST /v1/tokens`. " +
      "Every endpoint also accepts the session cookie set by `POST /v1/auth/sign-in`, which " +
      "is what the dashboard uses.",
  });

  registerInboundEmail(app, { db, files, logger, inboundSecret });
  registerAuthRoutes(app, { db, sessions, passwords, trustedOrigin });
  registerTokenRoutes(app, { db });
  registerTicketRoutes(app, { db });
  registerDraftRoutes(app, {
    db,
    dailyTokenBudget,
    ...(now ? { now } : {}),
    ...(noticeDelaySeconds !== undefined ? { noticeDelaySeconds } : {}),
  });
  registerAiUsageRoute(app, {
    db,
    dailyTokenBudget,
    ...(now ? { now } : {}),
  });
  registerKnowledgeRoutes(app, { db });
  registerStatsRoutes(app, { db, ...(now ? { now } : {}) });
  registerShadowModeRoutes(app, { db, allowShadowModeOff });
  registerGithubRoutes(app, {
    db,
    logger,
    publicUrl,
    secretBox,
    github,
    model,
    dailyTokenBudget,
    noticeDelaySeconds,
    issueRecheckSeconds,
    webhookSecretCacheMs,
    ...(now ? { now } : {}),
  });

  if (webDir) registerDashboard(app, webDir);

  // Unexpected errors are logged with details; the caller gets nothing it could use. A request
  // the framework itself refused (a body type no route takes, say) keeps its 4xx: it's the
  // caller's to fix, not a server fault.
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      return c.json({ error: clientErrorCodes[err.status] ?? "bad_request" }, err.status);
    }
    logger.error({ err, path: c.req.path }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  // The public API contract. The dashboard, SDK and MCP tools are generated from it.
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: `${brand.name} API`, version: "0.0.0" },
  });

  return app;
}

/** The framework's own refusals, as the API's error codes. Never its message. */
const clientErrorCodes: Partial<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "too_large",
  415: "unsupported_media_type",
};
