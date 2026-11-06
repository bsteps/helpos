import { fileURLToPath } from "node:url";
import { parseAiConfig } from "./config.ts";
import { runEvals } from "./evals/runner.ts";
import { createModel } from "./model.ts";

// Mock by default. EVAL_LIVE=1 calls the real provider from env: local/manual only, never in CI.
const live = process.env.EVAL_LIVE === "1";
const model = live ? createModel(parseAiConfig(process.env)) : undefined;
const dir = fileURLToPath(new URL("../evals", import.meta.url));

const results = await runEvals(dir, model);
const out = process.stdout;
out.write(`Evals (${live ? "live model" : "mock model"}):\n`);
for (const r of results) {
  out.write(`  ${r.failures.length === 0 ? "PASS" : "FAIL"}  ${r.name} (${r.file})\n`);
  for (const f of r.failures) out.write(`        - ${f}\n`);
}
const failed = results.filter((r) => r.failures.length > 0).length;
out.write(`${results.length - failed} passed, ${failed} failed\n`);
if (results.length === 0 || failed > 0) process.exitCode = 1;
