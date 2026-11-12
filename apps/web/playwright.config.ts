import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// `pnpm test:e2e` (from the repo root: builds the dashboard first). Needs Docker: the server it
// starts runs a throwaway Postgres and Mailpit (apps/server/src/e2e/serve.ts).
const port = Number(process.env.E2E_PORT ?? 4173);
export const stateFile = fileURLToPath(new URL("./.e2e/state.json", import.meta.url));
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // One server and one workspace for every test: run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: ci,
  // Flaky tests are bugs to fix, not to retry (ADR 0005).
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: ci ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    // Numbers and dates render in the browser's locale, which otherwise follows the machine.
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // The owner sets their password through the one-time link once; the rest sign in with it.
    { name: "setup", testMatch: /.*\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "laptop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } },
      dependencies: ["setup"],
    },
    { name: "phone", use: { ...devices["Pixel 7"] }, dependencies: ["setup"] },
  ],
  webServer: {
    command: "pnpm --filter @helpos/server e2e-server",
    url: `http://localhost:${port}/health`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    env: { E2E_PORT: String(port), E2E_STATE_FILE: stateFile },
  },
});
