import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { envSchema } from "./env.ts";

const base = {
  HELPOS_DATABASE_URL: "postgres://a:b@localhost:1/test",
  HELPOS_DATABASE_JOBS_URL: "postgres://a:b@localhost:1/test",
};

describe("AI startup configuration", () => {
  it.each([
    { AI_PROVIDER: "private-invalid-provider" },
    { AI_PROVIDER: "openai", AI_MODEL: "example" },
    { AI_MODEL: "orphan-model" },
    { AI_EMBEDDING_PROVIDER: "private-invalid-provider" },
    { AI_EMBEDDING_PROVIDER: "openai" },
    { AI_EMBEDDING_BASE_URL: "private-invalid-url" },
    { AI_EMBEDDING_PROVIDER: "openai", AI_EMBEDDING_BASE_URL: "ftp://localhost" },
  ])("rejects malformed settings without disclosing values: %j", (settings) => {
    const result = envSchema.safeParse({ ...base, ...settings });
    expect(result.success).toBe(false);
    const diagnostic = JSON.stringify(result.error);
    expect(diagnostic).toMatch(/AI_(EMBEDDING_)?/);
    for (const value of Object.values(settings)) expect(diagnostic).not.toContain(value);
  });

  it.each(["AI_PROVIDER", "AI_EMBEDDING_PROVIDER"])(
    "refuses actual startup with a safe diagnostic for %s",
    (variable) => {
      const env = { ...process.env, ...base };
      for (const key of Object.keys(env)) if (key.startsWith("AI_")) delete env[key];
      env[variable] = "private-provider-value";
      const result = spawnSync(process.execPath, ["src/main.ts"], {
        env,
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(variable);
      expect(result.stderr).not.toContain("private-provider-value");
      expect(result.stderr).not.toContain("ECONNREFUSED");
    },
  );
});
