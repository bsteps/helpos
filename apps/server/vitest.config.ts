import { defineConfig } from "vitest/config";

// Tests start a real Postgres container (ADR 0005), which takes a few seconds the first time.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 180_000 },
});
