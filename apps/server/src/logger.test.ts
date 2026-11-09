import { describe, expect, it } from "vitest";
import { createLogger, errorSummary } from "./logger.ts";

const pat = "github_pat_11AAAAAAA0secretsecretsecret_abcdefghijklmnopqrstuvwxyz0123";

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: "info" }, { write: (line: string) => lines.push(line) });
  return { logger, output: () => lines.join("") };
}

describe("logger", () => {
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
  // A Drizzle query error: the SQL parameters (an email address, a message body) are in its
  // message, and the Postgres error is its cause.
  const queryError = () =>
    new Error("Failed query: insert into messages\nparams: secret@customer.test,private body", {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "messages_tenant_message_id",
      }),
    });

  it("logs a raw error as its summary, whichever way it's passed", () => {
    const { logger, output } = capture();
    // The line from #56 that leaked the parameters, before errorSummary() existed.
    logger.error({ err: queryError(), path: "/v1/inbound/email" }, "unhandled error");
    logger.warn({ error: queryError() }, "a different key");
    logger.error(queryError(), "the error as the first argument");
    expect(output()).not.toContain("secret@customer.test");
    expect(output()).not.toContain("private body");
    // What is kept is still enough to find the bug.
    expect(output()).toContain("23505");
    expect(output()).toContain("messages_tenant_message_id");
    expect(output()).toContain("/v1/inbound/email");
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
