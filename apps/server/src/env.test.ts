import { describe, expect, it } from "vitest";
import { envSchema } from "./env.ts";

describe("envSchema", () => {
  it("applies defaults", () => {
    const env = envSchema.parse({
      HELPOS_DATABASE_URL: "postgres://a:b@localhost:5432/helpos",
      HELPOS_DATABASE_JOBS_URL: "postgres://j:k@localhost:5432/helpos",
    });
    expect(env.HELPOS_PORT).toBe(3000);
    expect(env.HELPOS_LOG_LEVEL).toBe("info");
    expect(env.HELPOS_SMTP_URL).toBeUndefined();
    expect(env.HELPOS_AI_DAILY_TOKEN_BUDGET).toBe(200_000);
  });

  it("rejects a missing jobs database URL", () => {
    expect(() =>
      envSchema.parse({ HELPOS_DATABASE_URL: "postgres://a:b@localhost:5432/helpos" }),
    ).toThrow();
  });

  it("rejects a missing database URL", () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});
