import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      ...["apps/server", "apps/web", "packages/db"].map((root) => ({
        extends: `./${root}/vitest.config.ts`,
        test: { root, maxWorkers: 3 },
      })),
      ...["packages/ai", "packages/brand", "packages/files", "packages/safe-fetch"].map((root) => ({
        test: { root, maxWorkers: 3 },
      })),
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "apps/web/src/api/schema.gen.ts",
        "apps/web/src/routeTree.gen.ts",
        "apps/server/src/testing/**",
        "apps/server/src/**/testing.ts",
        "apps/server/src/e2e/**",
        "packages/db/src/testing.ts",
        "packages/ai/src/testing.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: { statements: 76, branches: 64, functions: 70, lines: 77 },
    },
  },
});
