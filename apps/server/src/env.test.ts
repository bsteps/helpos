import { describe, expect, it } from "vitest";
import { envSchema } from "./env.ts";

describe("envSchema", () => {
  it("applies defaults", () => {
    const env = envSchema.parse({ HELPOS_DATABASE_URL: "postgres://a:b@localhost:5432/helpos" });
    expect(env.HELPOS_PORT).toBe(3000);
    expect(env.HELPOS_LOG_LEVEL).toBe("info");
  });

  it("rejects a missing database URL", () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});
