import { brand } from "@helpos/brand";
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { registerAiUsageRoute } from "./ai-budget/routes.ts";
import {
  type Authenticate,
  authenticateRequest,
  callerResolver,
  refuseAll,
} from "./auth/principal.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { humanSessions } from "./auth/session.ts";
import { registerConversationRoutes } from "./conversations/routes.ts";
import { registerDraftRoutes } from "./drafts/routes.ts";
import type { ErrorCode } from "./http/error-codes.ts";
import { registerHealthRoutes } from "./http/health.ts";
import { idempotency } from "./http/idempotency.ts";
import { httpConventions } from "./http/problem.ts";
import { errorResponse, notFound } from "./http/route-kit.ts";
import { registerInboundEmail } from "./inbound-email/route.ts";
import { registerKnowledgeRoutes } from "./knowledge/routes.ts";
import { withRequestId } from "./logger.ts";
import type { Services } from "./services.ts";
import { agentTokens } from "./tokens/authenticate.ts";
import { registerTokenRoutes } from "./tokens/routes.ts";
import { registerDashboard } from "./web/dashboard.ts";
import { registerShadowModeRoutes } from "./workspaces/shadow-mode-routes.ts";

/** What the API (web role) is built from: the shared services, never its own copies. */
export type AppServices = Pick<
  Services,
  "db" | "files" | "logger" | "clock" | "config" | "auth" | "queueReady"
>;

export interface AppOptions {
  /**
   * Resolves API callers. Defaults to agent tokens (`hos_…`) and, when sessions are
   * configured, human session cookies. Tests replace it to act as a signed-in human.
   */
  authenticate?: Authenticate;
}

export function createApp(services: AppServices, options: AppOptions = {}): OpenAPIHono {
  const { db, files, logger, clock, config, auth } = services;
  const { publicUrl, inboundSecret, webDir } = config;
  // Human sign-in needs HELPOS_AUTH_SECRET and HELPOS_DATABASE_AUTH_URL. Without it, sign-in
  // answers 503 and only agent tokens work.
  const sessions = auth?.sessions ?? undefined;
  // Only the one function the API needs for password links. Without it, setting a password
  // answers 503.
  const passwords = auth
    ? { setPassword: (token: string, password: string) => auth.setPassword(token, password) }
    : undefined;
  const trustedOrigin = new URL(publicUrl).origin;
  const resolve =
    options.authenticate ??
    authenticateRequest({
      tokens: agentTokens(db),
      session: sessions ? humanSessions({ sessions, db, trustedOrigin }) : refuseAll,
    });
  const app = new OpenAPIHono();
  // Every response carries X-Request-Id, and audit events record it.
  app.use("*", requestId());
  app.use("*", (c, next) => withRequestId(c.get("requestId"), next));
  app.use("*", httpConventions(logger));
  app.use("*", async (c, next) => {
    c.set("idempotency", idempotency(services));
    await next();
  });
  // Routes authenticate their own callers (see apiRoute()); this says how.
  app.use("*", callerResolver(resolve));

  registerHealthRoutes(app, services);

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
  registerConversationRoutes(app, { db });
  registerDraftRoutes(app, { db, clock, config, logger });
  registerAiUsageRoute(app, { db, clock, config, logger });
  registerKnowledgeRoutes(app, { db });
  registerShadowModeRoutes(app, { db, allowShadowModeOff: config.allowShadowModeOff });

  if (webDir) registerDashboard(app, webDir);

  app.notFound(notFound);

  // Unexpected errors are logged with details; the caller gets nothing it could use. A request
  // the framework itself refused (a body type no route takes, say) keeps its 4xx: it's the
  // caller's to fix, not a server fault.
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
      return errorResponse(c, { error: clientErrorCodes[err.status] ?? "bad_request" }, err.status);
    }
    logger.error({ err, requestId: c.get("requestId"), path: c.req.path }, "unhandled error");
    return errorResponse(c, { error: "internal_error" }, 500);
  });

  // The public API contract. The dashboard, SDK and MCP tools are generated from it.
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: `${brand.name} API`, version: "0.0.0" },
  });

  return app;
}

/** The framework's own refusals, as the API's error codes. Never its message. */
const clientErrorCodes: Partial<Record<number, ErrorCode>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  413: "too_large",
  415: "unsupported_media_type",
};
