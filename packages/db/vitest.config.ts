import { defineConfig } from "vitest/config";

// Tests start a real Postgres container (ADR 0005), which takes a few seconds the first time.
// Each test file starts its own, so `maxWorkers` caps how many run at once: without it, a
// many-core machine starts one per file in parallel, and Docker slows to a crawl.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 180_000, maxWorkers: 3 },
});
