import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppServices } from "../app.ts";
import { apiRoute } from "../auth/access.ts";
import { errorResponse, errorSchema, json } from "./route-kit.ts";

const healthRoute = apiRoute({
  operationId: "health.checkLiveness",
  method: "get",
  path: "/health",
  access: { noCaller: "Liveness reveals only that the HTTP process can answer a request." },
  security: [],
  responses: { 200: json(z.object({ status: z.literal("ok") }), "The HTTP process is live") },
});
const readyRoute = apiRoute({
  operationId: "health.checkReadiness",
  method: "get",
  path: "/readyz",
  access: { noCaller: "Readiness reveals only whether the database and job queues are available." },
  security: [],
  responses: {
    200: json(z.object({ status: z.literal("ok") }), "Database and job queues are available"),
    503: json(errorSchema, "Database or job queues are unavailable"),
  },
});

export function registerHealthRoutes(app: OpenAPIHono, services: AppServices) {
  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200));
  app.openapi(readyRoute, async (c) => {
    const [database, queue] = await Promise.all([services.db.ping(), services.queueReady()]);
    if (database.ok && queue.ok) return c.json({ status: "ok" as const }, 200);
    for (const [dependency, result] of [
      ["database", database],
      ["queue", queue],
    ] as const) {
      if (!result.ok) {
        services.logger.error(
          { err: result.error, dependency, requestId: c.get("requestId") },
          "readiness dependency unavailable",
        );
      }
    }
    return errorResponse(c, { error: "not_ready" }, 503);
  });
}
