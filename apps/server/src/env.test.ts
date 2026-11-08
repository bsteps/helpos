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
    expect(env.HELPOS_DATABASE_AUTH_URL).toBeUndefined();
    expect(env.HELPOS_PUBLIC_URL).toBe("http://localhost:3000");
    expect(env.HELPOS_NOTICE_DELAY_SECONDS).toBe(300);
    // Locked by default: shadow mode can't be turned off until this is set on purpose.
    expect(env.HELPOS_ALLOW_SHADOW_MODE_OFF).toBe(false);
  });

  it("only allows turning shadow mode off with exactly 'true'", () => {
    const base = {
      HELPOS_DATABASE_URL: "postgres://a:b@localhost:5432/helpos",
      HELPOS_DATABASE_JOBS_URL: "postgres://j:k@localhost:5432/helpos",
    };
    const allow = (v: string) =>
      envSchema.parse({ ...base, HELPOS_ALLOW_SHADOW_MODE_OFF: v }).HELPOS_ALLOW_SHADOW_MODE_OFF;
    expect(allow("true")).toBe(true);
    expect(allow("false")).toBe(false);
    expect(() => allow("yes")).toThrow();
  });

  it("reads the encryption key, and names a bad one without showing it", () => {
    const base = {
      HELPOS_DATABASE_URL: "postgres://a:b@localhost:5432/helpos",
      HELPOS_DATABASE_JOBS_URL: "postgres://j:k@localhost:5432/helpos",
    };
    expect(envSchema.parse(base).HELPOS_ENCRYPTION_KEY).toBeUndefined();
    expect(envSchema.parse({ ...base, HELPOS_ENCRYPTION_KEY: "" }).HELPOS_ENCRYPTION_KEY).toBe(
      undefined,
    );
    const hex = "ab".repeat(32);
    expect(envSchema.parse({ ...base, HELPOS_ENCRYPTION_KEY: hex }).HELPOS_ENCRYPTION_KEY).toEqual(
      Buffer.from(hex, "hex"),
    );
    const bad = "my-secret-but-too-short-key";
    const result = envSchema.safeParse({ ...base, HELPOS_ENCRYPTION_KEY: bad });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain("HELPOS_ENCRYPTION_KEY");
    expect(JSON.stringify(result.error)).not.toContain(bad);
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
