import { STATUS_CODES } from "node:http";
import type { MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { Services } from "../services.ts";
import { errorSchema } from "./route-kit.ts";

const errorBody = errorSchema.passthrough();

function problemBody(status: number, body: z.infer<typeof errorBody>, requestId: string) {
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
      const body: z.infer<typeof errorBody> = parsed.success
        ? parsed.data
        : { error: c.res.status >= 500 ? "internal_error" : "bad_request" };
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
