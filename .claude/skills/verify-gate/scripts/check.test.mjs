import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const skill = ".claude/skills/verify-gate";
const jar = ".helpos/tools/tla2tools-1.7.4.jar";
const java = spawnSync("java", ["-version"]);
const invariants = [
  "OneWriter",
  "LatestVersionOnly",
  "ApprovedMeansThatAction",
  "NoAutomaticResend",
  "OnlyPeopleApprove",
];

test("the gate model keeps every promise, each mutant breaks one, and a broken model fails", {
  // CI must never skip this silently: without Java there, the checker fails the test.
  skip: java.status !== 0 && !process.env.CI ? "Java is required for the TLC model check" : false,
  timeout: 240_000,
}, () => {
  const scratchParent = join(root, ".helpos");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "verify-gate-"));
  try {
    cpSync(join(root, skill), join(scratch, skill), { recursive: true });
    if (existsSync(join(root, jar))) cpSync(join(root, jar), join(scratch, jar));
    const run = () =>
      spawnSync(process.execPath, [join(scratch, skill, "scripts/check.mjs")], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 180_000,
      });

    const started = Date.now();
    const baseline = run();
    const output = `${baseline.stdout}\n${baseline.stderr}`;
    assert.equal(baseline.status, 0, output);
    assert.match(baseline.stdout, new RegExp(`base\\n  ok TypeOK, ${invariants.join(", ")}: hold`));
    const mutants = readdirSync(join(scratch, skill, "model/mutants"));
    assert.ok(mutants.length >= invariants.length, "a mutant for every promise");
    for (const file of mutants) {
      const header = readFileSync(join(scratch, skill, "model/mutants", file), "utf8");
      const broken = header.match(/^\\\* breaks: (\w+)/m)?.[1];
      assert.ok(broken, `${file} names the promise it breaks`);
      assert.match(
        baseline.stdout,
        new RegExp(`mutant ${file.replace(/\.tla$/, "")}\\n  ok ${broken}: broken`),
      );
    }
    for (const invariant of invariants) {
      assert.match(baseline.stdout, new RegExp(`ok ${invariant}: broken`), `${invariant} can fail`);
    }
    process.stdout.write(`# verify-gate checker ran in ${Date.now() - started}ms\n`);

    const model = join(scratch, skill, "model/Gate.tla");
    const source = readFileSync(model, "utf8");
    const guard = /^SubmitGuard\(a\) ==[\s\S]*?(?=\n\s*\n)/m;
    assert.match(source, guard);
    writeFileSync(model, source.replace(guard, "SubmitGuard(a) == TRUE"));
    const broken = run();
    assert.equal(broken.status, 1, `${broken.stdout}\n${broken.stderr}`);
    assert.match(broken.stdout, /base\n {2}!! (OneWriter|LatestVersionOnly): broken/);
    assert.match(broken.stdout, /is broken in the base model/);
    assert.doesNotMatch(broken.stdout, /Every promise holds/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
