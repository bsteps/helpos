import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.ts";

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
