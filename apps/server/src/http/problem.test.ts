import { createMemoryFileStore } from "@helpos/files";
import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { apiRoute } from "../auth/access.ts";
import { composeServices } from "../services.ts";
import { errorSchema, json } from "./route-kit.ts";

const unused = (): never => {
  throw new Error("private failure details");
};
function fixture() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = createApp(
    composeServices({
      db: {
        ping: unused,
        withTenant: unused,
        resolveMailbox: unused,
        resolveApiToken: unused,
        listMemberships: unused,
      },
      logger,
      files: createMemoryFileStore(),
    }),
  );
  for (const path of ["/raw-response", "/failure", "/conflict", "/framework", "/external"]) {
    app.openAPIRegistry.registerPath(
      apiRoute({
        operationId: `test.problem.${path.slice(1)}`,
        path,
        method: "get",
        access: { noCaller: "Exercises framework response normalization." },
        responses: {
          200: json(z.object({}), "Raw JSON response"),
          204: { description: "Empty response" },
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 413, 415, 422, 500].map((status) => [
              status,
              json(errorSchema, "Normalized problem"),
            ]),
          ),
        },
      }),
    );
  }
  return { app, logger };
}

describe("HTTP problem details and request IDs", () => {
  it.each([200, 204] as const)(
    "correlates a raw %s response with its completion log",
    async (status) => {
      const { app, logger } = fixture();
      app.get(
        "/raw-response",
        () =>
          new Response(status === 204 ? null : "{}", {
            status,
            headers: {
              "x-response-probe": "preserved",
              ...(status === 200 ? { "content-type": "application/json" } : {}),
            },
          }),
      );
      const requestId = `raw-response-${status}`;
      const res = await app.request("/raw-response", { headers: { "x-request-id": requestId } });
      expect(res.status).toBe(status);
      expect(res.headers.get("x-request-id")).toBe(requestId);
      expect(res.headers.get("x-response-probe")).toBe("preserved");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ requestId, status, path: "/raw-response" }),
        "request completed",
      );
    },
  );

  it.each([
    ["GET", "/missing", 404, "not_found"],
    ["GET", "/v1/conversations", 401, "unauthorized"],
    ["POST", "/v1/inbound/email", 401, "unauthorized"],
  ] as const)("normalizes %s %s", async (method, path, status, error) => {
    const { app, logger } = fixture();
    const res = await app.request(path, { method, headers: { "x-request-id": "correlation-123" } });
    expect(res.status).toBe(status);
    expect(res.headers.get("x-request-id")).toBe("correlation-123");
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: status === 404 ? "Not Found" : "Unauthorized",
      status,
      error,
      instance: "urn:request:correlation-123",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "correlation-123", status, path }),
      "request completed",
    );
  });

  it("generates a request ID and hides unexpected failure details in a 500", async () => {
    const { app, logger } = fixture();
    app.get("/failure", unused);
    const res = await app.request("/failure");
    const requestId = res.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({
      error: "internal_error",
      status: 500,
      instance: `urn:request:${requestId}`,
    });
    expect(JSON.stringify(body)).not.toContain("private failure");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId }),
      "unhandled error",
    );
  });

  it("preserves safe machine-readable error extensions", async () => {
    const { app } = fixture();
    app.get("/conflict", (c) =>
      c.json({ error: "url_taken", sourceId: "safe-id", retryAfter: 10 }, 409),
    );
    const res = await app.request("/conflict");
    expect(await res.json()).toMatchObject({
      error: "url_taken",
      sourceId: "safe-id",
      retryAfter: 10,
      status: 409,
    });
  });

  it.each([400, 401, 403, 404, 413, 415, 422] as const)(
    "maps framework refusal %s without exposing its message",
    async (status) => {
      const { app } = fixture();
      app.get("/framework", () => {
        throw new HTTPException(status, { message: "private provider details" });
      });
      const res = await app.request("/framework");
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).toMatchObject({
        error: {
          400: "bad_request",
          401: "unauthorized",
          403: "forbidden",
          404: "not_found",
          413: "too_large",
          415: "unsupported_media_type",
          422: "bad_request",
        }[status],
      });
      expect(JSON.stringify(body)).not.toContain("private provider details");
    },
  );

  it("labels an unreadable server failure as internal_error, not a caller mistake", async () => {
    const { app } = fixture();
    app.get("/raw-response", (c) => c.text("private failure details", 500));
    const res = await app.request("/raw-response");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ error: "internal_error", status: 500 });
    expect(body).not.toContain("private failure details");
  });

  it("does not trust arbitrary boundary strings or their extensions as public API errors", async () => {
    const { app } = fixture();
    app.get("/external", (c) =>
      c.json({ error: "private provider details", secret: "hidden" }, 422),
    );
    const res = await app.request("/external", { headers: { "x-request-id": "external-123" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "bad_request",
      type: "about:blank",
      title: "Unprocessable Entity",
      status: 422,
      instance: "urn:request:external-123",
    });
  });
});
