import type { MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { Services } from "../services.ts";
import { errorSchema } from "./route-kit.ts";

const errorBody = errorSchema.passthrough();

const errorTitles: Partial<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

function problemBody(status: number, body: z.infer<typeof errorBody>, requestId: string) {
  return {
    ...body,
    type: "about:blank",
    title: errorTitles[status] ?? "Error",
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
