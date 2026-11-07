import { brand } from "@helpos/brand";
import type { Database } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import type { Logger } from "pino";
import { defaultDailyTokenBudget } from "./ai-budget/budget.ts";
import { registerAiUsageRoute } from "./ai-budget/routes.ts";
import { type Authenticate, refuseAll } from "./auth/principal.ts";
import { registerDraftRoutes } from "./drafts/routes.ts";
import { registerInboundEmail } from "./inbound-email/route.ts";

export interface AppDeps {
  db: Pick<Database, "ping" | "withTenant" | "resolveMailbox">;
  files: FileStore;
  logger: Pick<Logger, "error" | "warn" | "info">;
  /** HELPOS_INBOUND_SECRET. When unset, the inbound email endpoint refuses every request. */
  inboundSecret: string | undefined;
  /** Resolves API callers. Defaults to refusing everyone until agent tokens and sessions exist. */
  authenticate?: Authenticate;
  /** Reported by the usage endpoint. The worker enforces it. */
  dailyTokenBudget?: number;
  /** For tests: the clock "today" is read from. */
  now?: () => Date;
}

export function createApp({
  db,
  files,
  logger,
  inboundSecret,
  authenticate = refuseAll,
  dailyTokenBudget = defaultDailyTokenBudget,
  now,
}: AppDeps): OpenAPIHono {
  const app = new OpenAPIHono();
  // Every response carries X-Request-Id, and audit events record it.
  app.use("*", requestId());

  // Liveness + readiness in one: the server is only useful if it can reach Postgres.
  // The body stays minimal on purpose, so it reveals nothing about the setup.
  app.get("/health", async (c) => {
    const ping = await db.ping();
    if (ping.ok) return c.json({ status: "ok", database: "ok" }, 200);
    // The details go to the log, never to the (unauthenticated) response.
    logger.error({ err: ping.error }, "health check: database unreachable");
    return c.json({ status: "error", database: "unreachable" }, 503);
  });

  registerInboundEmail(app, { db, files, logger, inboundSecret });
  registerDraftRoutes(app, { db, authenticate, dailyTokenBudget, ...(now ? { now } : {}) });
  registerAiUsageRoute(app, { db, authenticate, dailyTokenBudget, ...(now ? { now } : {}) });

  // Unexpected errors are logged with details; the caller gets nothing it could use.
  app.onError((err, c) => {
    logger.error({ err: errorSummary(err), path: c.req.path }, "unhandled error");
    return c.json({ error: "internal_error" }, 500);
  });

  // The public API contract. The dashboard, SDK and MCP tools are generated from it.
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: `${brand.name} API`, version: "0.0.0" },
  });

  return app;
}

/**
 * The frames after the message. The message (which may span lines and contain anything) is
 * cut off by position, not recognised by content. If the stack doesn't start with it, as
 * V8 normally does, nothing is returned rather than risk logging it.
 */
function stackFrames(err: Error): string | undefined {
  const header = `${err.name}: ${err.message}\n`;
  if (!err.stack?.startsWith(header)) return undefined;
  return err.stack.slice(header.length).split("\n").slice(0, 5).join("\n");
}

/**
 * What is safe to log about an unexpected error. Drizzle query errors carry the SQL
 * parameters (email bodies, addresses) in their message, so those are never logged; only the
 * error type, the Postgres SQLSTATE and constraint name, and the stack frames.
 */
export function errorSummary(err: unknown): Record<string, unknown> {
  const cause = err instanceof Error ? err.cause : undefined;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  // `throw null` is legal JS: the error handler must never crash on it.
  const pg = isObject(cause) ? cause : isObject(err) ? err : {};
  return {
    name: err instanceof Error ? err.name : typeof err,
    code: typeof pg.code === "string" ? pg.code : undefined,
    constraint: typeof pg.constraint_name === "string" ? pg.constraint_name : undefined,
    stack: err instanceof Error ? stackFrames(err) : undefined,
  };
}
