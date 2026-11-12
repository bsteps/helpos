import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/knowledge/page-fetch.test.ts"] },
});
