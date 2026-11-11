import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const skill = ".claude/skills/verify-send-reply";
const java = spawnSync("java", ["-version"]);

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
      "apps/server/src/drafts/send-worker.ts",
      "apps/server/src/drafts/lifecycle.ts",
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
