import { defineConfig } from "vitest/config";

// Tests use a real Postgres (ADR 0005). The global setup starts one container for the run,
// and each test file copies its own migrated database from it. `maxWorkers` keeps the
// machine responsive: the app tests are heavy, and Docker shares the same CPUs.
export default defineConfig({
  test: {
    globalSetup: ["../../packages/db/src/testing.ts"],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    maxWorkers: 3,
  },
});
