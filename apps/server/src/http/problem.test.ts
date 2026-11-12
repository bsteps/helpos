import { createMemoryFileStore } from "@helpos/files";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { composeServices } from "../services.ts";

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
  return { app, logger };
}

describe("HTTP problem details and request IDs", () => {
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
});
