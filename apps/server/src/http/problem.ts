import { STATUS_CODES } from "node:http";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Services } from "../services.ts";

const errorBody = z.object({ error: z.string() }).passthrough();

function problemBody(status: number, body: { error: string }, requestId: string) {
  return {
    ...body,
    type: "about:blank",
    title: STATUS_CODES[status] ?? "Error",
    status,
    instance: `urn:request:${encodeURIComponent(requestId)}`,
  };
}

export function httpConventions(logger: Services["logger"]): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const requestId = c.get("requestId");
    if (c.res.status >= 400) {
      const parsed = errorBody.safeParse(
        await c.res
          .clone()
          .json()
          .catch(() => null),
      );
      const body = parsed.success ? parsed.data : { error: "bad_request" };
      c.res = new Response(JSON.stringify(problemBody(c.res.status, body, requestId)), {
        status: c.res.status,
        headers: c.res.headers,
      });
      c.header("Content-Type", "application/problem+json");
    }
    c.header("X-Request-Id", requestId);
    logger.info(
      { requestId, method: c.req.method, path: c.req.path, status: c.res.status },
      "request completed",
    );
  };
}
