import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 180_000,
    maxWorkers: 3,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "int",
          include: ["**/src/**/*.int.test.ts"],
          globalSetup: [fileURLToPath(new URL("./packages/db/src/testing.ts", import.meta.url))],
        },
      },
    ],
  },
});
