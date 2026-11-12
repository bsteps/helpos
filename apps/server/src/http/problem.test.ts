import { createMemoryFileStore } from "@helpos/files";
import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { type AppServices, createApp } from "../app.ts";
import { apiRoute } from "../auth/access.ts";
import { maxEmailBytes } from "../inbound-email/route.ts";
import { createLogger } from "../logger.ts";
import { composeServices } from "../services.ts";
import { errorSchema, json } from "./route-kit.ts";

const unused = (): never => {
  throw new Error("private failure details");
};
const errorStatuses = Object.entries(STATUS_CODES).filter(([code]) => Number(code) >= 400);
function fixture(logger: AppServices["logger"] = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }) {
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
      config: { inboundSecret: "test-inbound-secret" },
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
            errorStatuses.map(([status]) => [status, json(errorSchema, "Normalized problem")]),
          ),
        },
      }),
    );
  }
  return { app, logger };
}

describe("HTTP problem details and request IDs", () => {
  it.each(errorStatuses)("keeps the standard title for HTTP status %s", async (code, title) => {
    const { app } = fixture();
    app.get(
      "/raw-response",
      () =>
        new Response(JSON.stringify({ error: "bad_request" }), {
          status: Number(code),
          headers: { "content-type": "application/json" },
        }),
    );
    const response = await app.request("/raw-response");
    expect(response.status).toBe(Number(code));
    expect(await response.json()).toMatchObject({ title, status: Number(code) });
  });

  it("correlates the inbound email handler's own warning with its error response", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (line) => lines.push(line) });
    const { app } = fixture(logger);
    const response = await app.request("/v1/inbound/email", {
      method: "POST",
      headers: {
        authorization: "Bearer test-inbound-secret",
        "content-type": "message/rfc822",
        "content-length": String(maxEmailBytes + 1),
        "x-request-id": "inbound-rejection",
      },
      body: "unread email body",
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("x-request-id")).toBe("inbound-rejection");
    expect(await response.json()).toMatchObject({ instance: "urn:request:inbound-rejection" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        msg: "inbound email rejected: too large",
        requestId: "inbound-rejection",
      }),
      expect.objectContaining({ msg: "request completed", requestId: "inbound-rejection" }),
    ]);
    expect(lines.join("")).not.toContain("test-inbound-secret");
    expect(lines.join("")).not.toContain("unread email body");
  });

  it("keeps every nested service log tied to its request during concurrent requests", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (line) => lines.push(line) });
    const { app } = fixture(logger);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    app.get("/raw-response", async (c) => {
      const label = c.req.query("label");
      logger.info({ label, phase: "before" }, "nested service");
      if (label === "first") {
        started.resolve();
        await release.promise;
      } else {
        await started.promise;
        release.resolve();
      }
      logger.warn({ label, phase: "after" }, "nested service");
      return c.json({});
    });
    const responses = await Promise.all(
      ["first", "second"].map((label) =>
        app.request(`/raw-response?label=${label}`, {
          headers: { "x-request-id": `${label}-request` },
        }),
      ),
    );
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries).toHaveLength(6);
    for (const [index, label] of ["first", "second"].entries()) {
      expect(responses[index]?.headers.get("x-request-id")).toBe(`${label}-request`);
      for (const phase of ["before", "after"]) {
        expect(entries).toContainEqual(
          expect.objectContaining({ label, phase, requestId: `${label}-request` }),
        );
      }
    }
  });

  it("correlates nested and error logs with generated IDs without leaking into unrelated logs", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (line) => lines.push(line) });
    const { app } = fixture(logger);
    logger.info("outside request: before");
    app.get("/failure", async () => {
      await Promise.resolve();
      logger.warn("nested service failure");
      return unused();
    });
    const response = await app.request("/failure");
    const requestId = response.headers.get("x-request-id");
    logger.info("outside request: after");
    const entries = lines.map((line) => JSON.parse(line));
    expect(response.status).toBe(500);
    expect(requestId).toBeTruthy();
    expect(entries).toEqual([
      expect.not.objectContaining({ requestId: expect.anything() }),
      expect.objectContaining({ msg: "nested service failure", requestId }),
      expect.objectContaining({ msg: "unhandled error", requestId }),
      expect.objectContaining({ msg: "request completed", requestId }),
      expect.not.objectContaining({ requestId: expect.anything() }),
    ]);
    expect(lines.join("")).not.toContain("private failure details");
  });

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

import { STATUS_CODES } from "node:http";
