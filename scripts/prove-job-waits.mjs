import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "packages/db/src/testing.ts");
const original = readFileSync(source);
const evidence = resolve(
  root,
  ".helpos/job-wait-mutations",
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(evidence, { recursive: true });
writeFileSync(resolve(evidence, "testing.ts.backup"), original);

function run(name, filter, broken) {
  const result = spawnSync(
    `pnpm --filter @helpos/db exec vitest run --project int src/testing-jobs.int.test.ts${filter ? ` -t "${filter}"` : ""}`,
    { cwd: root, shell: true, encoding: "utf8", timeout: 180_000 },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(resolve(evidence, `${name}.log`), output);
  if (result.error || result.status !== (broken ? 1 : 0)) {
    throw new Error(`${name}: unexpected exit; see ${evidence}`);
  }
  if (broken && (!output.includes("AssertionError") || !output.includes("Tests  1 failed"))) {
    throw new Error(`${name}: intended assertion did not fail; see ${evidence}`);
  }
  process.stdout.write(`${name}: ${broken ? "intended assertion failed" : "passed"}\n`);
}

const states = '["created", "retry", "active"]';
if (!original.toString().includes(states)) throw new Error("Job-state mutation no longer matches");
run("baseline", "", false);
for (const [name, replacement, filter] of [
  ["ignores-queued", '["retry", "active"]', "cannot prove no effect"],
  ["ignores-active", '["created", "retry"]', "cannot prove no effect"],
  ["ignores-backoff", '["created", "active"]', "waits through retry backoff"],
]) {
  try {
    writeFileSync(source, original.toString().replace(states, replacement));
    writeFileSync(resolve(evidence, `${name}.mutation.txt`), `${states}\n=> ${replacement}\n`);
    run(name, filter, true);
  } finally {
    writeFileSync(source, original);
  }
}
run("restored", "", false);
if (!readFileSync(source).equals(original)) throw new Error("Source restoration failed");
process.stdout.write(`Evidence: ${evidence}\n`);
