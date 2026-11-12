import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const skill = ".claude/skills/verify-send-reply";
const java = spawnSync("java", ["-version"]);

function checkerFunctions(repoRoot) {
  const source = ts.createSourceFile(
    "check.mjs",
    readFileSync(join(root, skill, "scripts/check.mjs"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = ["fingerprint", "findNamed", "isDeclaration", "sha256"];
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text),
  );
  assert.equal(declarations.length, names.length);
  return runInNewContext(
    `${declarations.map((node) => node.getText(source)).join("\n")}\n({ fingerprint, findNamed })`,
    { ts, repoRoot, join, existsSync, readFileSync, createHash },
  );
}

test("every covered function body edit invalidates its own coverage record", () => {
  const scratchParent = join(root, ".helpos");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "fingerprint-regression-"));
  try {
    const { fingerprint } = checkerFunctions(scratch);
    const record = readFileSync(join(root, skill, "SKILL.md"), "utf8");
    const rows = [...record.matchAll(/^\| ([^|]+) \| ([^|]+) \| [^|]+ \| `([^`]+)` \|/gm)];
    const checked = [];
    for (const [, moduleCell, symbolCell, recorded] of rows) {
      const module = moduleCell.trim();
      const symbol = symbolCell.trim();
      if (!module.endsWith(".ts")) continue;
      const file = join(scratch, module);
      mkdirSync(join(file, ".."), { recursive: true });
      const original = readFileSync(join(root, module), "utf8");
      writeFileSync(file, original);
      const source = ts.createSourceFile(module, original, ts.ScriptTarget.Latest, true);
      let target;
      const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === symbol.split(".").at(-1))
          target = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!target?.body) continue;
      const before = fingerprint(module, symbol);
      assert.equal(before, recorded, `${symbol} matches its coverage record`);
      const insertion = target.body.getStart(source) + 1;
      writeFileSync(
        file,
        `${original.slice(0, insertion)}\nthrow new Error("fingerprint regression");\n${original.slice(insertion)}`,
      );
      assert.notEqual(
        fingerprint(module, symbol),
        recorded,
        `${module} ${symbol} must fingerprint its function body`,
      );
      writeFileSync(file, original);
      assert.equal(fingerprint(module, symbol), before, `${symbol} restored`);
      checked.push(symbol);
    }
    for (const symbol of [
      "markSending",
      "rejectSend",
      "markSent",
      "markSendFailed",
      "createJobRunner.consume",
      "createJobRunner.work",
    ])
      assert.ok(checked.includes(symbol), symbol);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("coverage fingerprints the lifecycle function rather than its transition entry", () => {
  const checker = ts.createSourceFile(
    "check.mjs",
    readFileSync(join(root, skill, "scripts/check.mjs"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = checker.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "findNamed",
  );
  assert.ok(declaration);
  const findNamed = runInNewContext(`(${declaration.getText(checker)})`, { ts });
  const source = ts.createSourceFile(
    "lifecycle.ts",
    'const draftTransitions = { markSending: { from: ["approved"] } }; export function markSending() { return "changed"; }',
    ts.ScriptTarget.Latest,
    true,
  );
  const found = findNamed(source, "markSending");
  assert.ok(ts.isFunctionDeclaration(found));
  assert.match(found.getText(source), /return "changed"/);
});

test("a new stall cannot hide behind the accepted lost-retry finding", {
  skip: java.status !== 0 ? "Java is required for the TLC regression test" : false,
  timeout: 120_000,
}, () => {
  const scratchParent = join(root, ".helpos");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(join(scratchParent, "control-regression-"));
  try {
    cpSync(join(root, skill), join(scratch, skill), { recursive: true });
    for (const file of [
      "apps/server/src/conversations/lifecycle.ts",
      "apps/server/src/drafts/send-worker.ts",
      "apps/server/src/drafts/lifecycle.ts",
      "apps/server/src/outbound-email/composer.ts",
      "apps/server/src/jobs.ts",
      "packages/db/src/jobs.ts",
      "packages/db/node_modules/pg-boss/package.json",
    ])
      cpSync(join(root, file), join(scratch, file), { recursive: true });
    const jar = ".helpos/tools/tla2tools-1.7.4.jar";
    if (existsSync(join(root, jar)))
      cpSync(join(root, jar), join(scratch, jar), { recursive: true });
    const run = () =>
      spawnSync(process.execPath, [join(scratch, skill, "scripts/check.mjs")], {
        cwd: scratch,
        encoding: "utf8",
        timeout: 50_000,
      });
    const baseline = run();
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
    for (const property of [
      "NoSilentStall",
      "NoHiddenDelivery",
      "NoResendWithoutPerson",
      "SentOnlyWhenApproved",
    ]) {
      assert.match(baseline.stdout, new RegExp(`control [^\\n]+\\n  ok ${property}: holds`));
    }
    const model = join(scratch, skill, "model/SendReply.tla");
    const source = readFileSync(model, "utf8");
    assert.ok(source.includes('MarkSendFailedFrom == {"approved"}'));
    writeFileSync(
      model,
      source.replace('MarkSendFailedFrom == {"approved"}', "MarkSendFailedFrom == {}"),
    );
    const broken = run();
    assert.equal(broken.status, 1, `${broken.stdout}\n${broken.stderr}`);
    assert.match(
      broken.stdout,
      /control give-up-does-nothing already breaks NoSilentStall without mutation/,
    );
    assert.doesNotMatch(broken.stdout, /Every result matches the expected table/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
