import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { envSchema } from "./env.ts";
import { createLogger } from "./logger.ts";
import { serverFromEnv } from "./server.ts";
import { defaultConfig } from "./services.ts";

const base = {
  HELPOS_DATABASE_URL: "postgres://a:b@localhost:1/test",
  HELPOS_DATABASE_JOBS_URL: "postgres://a:b@localhost:1/test",
};

describe("AI startup configuration", () => {
  it.each([
    {},
    {
      AI_PROVIDER: "",
      AI_MODEL: "",
      AI_API_KEY: "",
      AI_EMBEDDING_PROVIDER: "",
      AI_EMBEDDING_MODEL: "",
      AI_EMBEDDING_API_KEY: "",
      AI_EMBEDDING_BASE_URL: "",
    },
  ])("keeps empty groups disabled", async (settings) => {
    const env = envSchema.parse({ ...base, ...settings });
    const server = serverFromEnv(env, createLogger({ level: "silent" }));
    expect(server.services.model).toBeUndefined();
    expect(server.services.embeddingModel).toBeUndefined();
    expect(env.HELPOS_PUBLIC_URL).toBe(defaultConfig.publicUrl);
    await server.close();
  });

  it.each(["openai", "anthropic"])(
    "uses parsed %s configuration without probing remote services",
    async (provider) => {
      const env = envSchema.parse({
        ...base,
        AI_PROVIDER: provider,
        AI_MODEL: "custom-model",
        AI_API_KEY: "synthetic-key",
        AI_EMBEDDING_PROVIDER: "openai",
        AI_EMBEDDING_BASE_URL: "http://127.0.0.1:1/v1",
      });
      const server = serverFromEnv(env, createLogger({ level: "silent" }));
      expect(server.services.model).toMatchObject({ modelId: "custom-model" });
      expect(server.services.embeddingModel).toMatchObject({ modelId: "text-embedding-3-small" });
      await server.close();
    },
  );

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
      const env: NodeJS.ProcessEnv = { ...process.env, ...base };
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
