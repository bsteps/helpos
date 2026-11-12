import { describe, expect, it } from "vitest";
import { createLogger, errorSummary, withoutRequestId, withRequestId } from "./logger.ts";

const pat = "github_pat_11AAAAAAA0secretsecretsecret_abcdefghijklmnopqrstuvwxyz0123";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: "info" }, { write: (line: string) => lines.push(line) });
  return { logger, output: () => lines.join("") };
}

describe("logger", () => {
  it("restores the HTTP context after an independent callback throws", () => {
    const { logger, output } = capture();
    withRequestId("active-request", () => {
      expect(() =>
        withoutRequestId(() => {
          logger.info("independent callback");
          throw new Error("callback failed");
        }),
      ).toThrow("callback failed");
      logger.info("HTTP request continues");
    });
    expect(
      output()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.not.objectContaining({ requestId: expect.anything() }),
      expect.objectContaining({ msg: "HTTP request continues", requestId: "active-request" }),
    ]);
  });

  it("uses the active request ID on child loggers and preserves redaction", async () => {
    const { logger, output } = capture();
    const child = logger.child({ component: "nested-service" });
    await withRequestId("current-request", async () => {
      await Promise.resolve();
      child.info({ requestId: "stale-request", token: pat }, "service called");
      child.warn("string-only log");
    });
    expect(output()).not.toContain(pat);
    expect(output()).not.toContain("stale-request");
    expect(
      output()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        requestId: "current-request",
        component: "nested-service",
        token: "[redacted]",
      }),
      expect.objectContaining({ requestId: "current-request", msg: "string-only log" }),
    ]);
  });

  it("redacts a token logged by accident, at the top level or one level down", () => {
    const { logger, output } = capture();
    logger.info({ token: pat }, "connect");
    logger.warn({ input: { token: pat, repo: "acme/app" } }, "connect failed");
    logger.error({ request: { headers: { authorization: `token ${pat}` } } }, "github call");
    logger.info({ authorization: `Bearer ${pat}` }, "raw header");
    expect(output()).not.toContain(pat);
    expect(output()).toContain("[redacted]");
    // Only the secret goes; the rest of the entry is still useful.
    expect(output()).toContain("acme/app");
  });

  it("redacts webhook secrets and passwords too", () => {
    const { logger, output } = capture();
    logger.info({ webhookSecret: "whsec-1234", body: { password: "hunter2" } }, "x");
    expect(output()).not.toContain("whsec-1234");
    expect(output()).not.toContain("hunter2");
  });
});

describe("logger: errors", () => {
  // Shaped like drizzle-orm's DrizzleQueryError: the SQL parameters (an email address, a
  // message body) are in its message and its own enumerable `params`, and the Postgres error
  // is its cause.
  const queryError = () =>
    Object.assign(
      new Error("Failed query: insert into messages\nparams: secret@customer.test,private body", {
        cause: Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint_name: "messages_tenant_message_id",
        }),
      }),
      { query: "insert into messages", params: ["secret@customer.test", "private body"] },
    );

  it("logs a raw error as its summary, whichever way it's passed", () => {
    const { logger, output } = capture();
    // The line from #56 that leaked the parameters, before errorSummary() existed.
    logger.error({ err: queryError(), path: "/v1/inbound/email" }, "unhandled error");
    logger.warn({ error: queryError() }, "a different key");
    logger.error(queryError(), "the error as the first argument");
    // With no message, pino would use the error's own message as the line.
    logger.error(queryError());
    logger.error({ err: queryError() });
    expect(output()).not.toContain("secret@customer.test");
    expect(output()).not.toContain("private body");
    // What is kept is still enough to find the bug.
    expect(output()).toContain("23505");
    expect(output()).toContain("messages_tenant_message_id");
    expect(output()).toContain("/v1/inbound/email");
  });

  it("logs an error nested anywhere in the entry as its summary", () => {
    const { logger, output } = capture();
    logger.error({ job: { id: "j1", lastError: queryError() } }, "job failed");
    logger.warn({ results: [{ ok: false, reason: queryError() }] }, "batch failed");
    logger.info({ cause: queryError() }, "a key with no serializer");
    logger.error("format argument: %o", queryError());
    logger.error("an object as a format argument: %o", { job: { lastError: queryError() } });
    logger.error([queryError()]);
    expect(output()).not.toContain("secret@customer.test");
    expect(output()).not.toContain("private body");
    expect(output()).toContain("23505");
    expect(output()).toContain("j1");
  });
});

describe("errorSummary", () => {
  it("never includes the message, where Drizzle puts query parameters", () => {
    const pgError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "messages_tenant_message_id",
    });
    const err = new Error("Failed query: insert ...\n    at secret@customer.test,private body", {
      cause: pgError,
    });
    const summary = errorSummary(err);
    expect(summary).toMatchObject({
      name: "Error",
      code: "23505",
      constraint: "messages_tenant_message_id",
    });
    expect(JSON.stringify(summary)).not.toContain("secret@customer.test");
    expect(summary.stack).toMatch(/logger\.test\.ts/);
  });

  it.each([null, undefined, "text"])("handles a thrown %j without crashing", (thrown) => {
    expect(errorSummary(thrown)).toMatchObject({ name: typeof thrown });
  });
});
