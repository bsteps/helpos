import type { Database } from "@helpos/db";
import { Hono } from "hono";
import type { Logger } from "pino";

export interface AppDeps {
  db: Pick<Database, "ping">;
  logger: Pick<Logger, "error">;
}

export function createApp({ db, logger }: AppDeps): Hono {
  const app = new Hono();

  // Liveness + readiness in one: the server is only useful if it can reach Postgres.
  // The body stays minimal on purpose, so it reveals nothing about the setup.
  app.get("/health", async (c) => {
    const ping = await db.ping();
    if (ping.ok) return c.json({ status: "ok", database: "ok" }, 200);
    // The details go to the log, never to the (unauthenticated) response.
    logger.error({ err: ping.error }, "health check: database unreachable");
    return c.json({ status: "error", database: "unreachable" }, 503);
  });

  return app;
}
