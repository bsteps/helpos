import { defineConfig } from "vitest/config";

// Unit tests only. The browser flows are Playwright's (e2e/, `pnpm test:e2e`).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
