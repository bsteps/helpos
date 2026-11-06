import type { Database } from "@helpos/db";
import { Hono } from "hono";

export interface AppDeps {
  db: Pick<Database, "ping">;
}

export function createApp({ db }: AppDeps): Hono {
  const app = new Hono();

  // Liveness + readiness in one: the server is only useful if it can reach Postgres.
  // The body stays minimal on purpose, so it reveals nothing about the setup.
  app.get("/health", async (c) => {
    const dbOk = await db.ping();
    return dbOk
      ? c.json({ status: "ok", database: "ok" }, 200)
      : c.json({ status: "error", database: "unreachable" }, 503);
  });

  return app;
}
