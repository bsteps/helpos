import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.mts";

export default defineConfig({
  test: {
    testTimeout: base.test.testTimeout,
    hookTimeout: base.test.hookTimeout,
    projects: [
      ...["apps/server", "packages/db"].flatMap((root) =>
        base.test.projects.map((project) => ({
          extends: true,
          test: {
            ...project.test,
            root,
            name: `${root}:${project.test.name}`,
            maxWorkers: 3,
            ...(root === "apps/server"
              ? {
                  setupFiles: [
                    fileURLToPath(new URL("./apps/server/src/testing/setup.ts", import.meta.url)),
                  ],
                }
              : {}),
          },
        })),
      ),
      { extends: "./apps/web/vitest.config.ts", test: { root: "apps/web", maxWorkers: 3 } },
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
