import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./index.mjs", import.meta.url));

test("the CI command fails missing proof, passes proof, and reports exceptions safely", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "proof-check-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  git("init", "--quiet");
  git("config", "user.email", "proof@example.test");
  git("config", "user.name", "Proof test");
  git("commit", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  write("apps/web/src/routes/example.tsx", "example");
  git("add", ".");
  git("commit", "-m", "source");
  const run = (body, sha = git("rev-parse", "HEAD"), baseSha = base) => {
    write(
      "event.json",
      JSON.stringify({ pull_request: { base: { sha: baseSha }, head: { sha }, body } }),
    );
    return spawnSync(process.execPath, [cli, join(cwd, "event.json")], {
      cwd,
      encoding: "utf8",
    });
  };
  const missing = run(null);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /"status":"fail"/);
  const exception = run("Proof: not needed because $(exit 99) `literal`\n::error::untrusted");
  assert.equal(exception.status, 0, exception.stderr);
  assert.match(exception.stdout, /"status":"exception"/);
  assert.match(exception.stdout, /\$\(exit 99\)/);
  assert.doesNotMatch(exception.stdout, /^::error::/m);
  assert.notEqual(run("", "--output=oops").status, 0);
  write("apps/web/e2e/example.spec.ts", "proof");
  git("add", "apps/web/e2e/example.spec.ts");
  git("commit", "-m", "proof");
  assert.equal(run("").status, 0);
  const proofHead = git("rev-parse", "HEAD");
  git("checkout", "-b", "base-advance", base);
  write("apps/server/src/inbound-email/base-only.ts", "unrelated base change");
  git("add", "apps/server/src/inbound-email/base-only.ts");
  git("commit", "-m", "advance base");
  assert.equal(run("", proofHead, git("rev-parse", "HEAD")).status, 0);
});

test("workflow runs on PR updates and body edits without interpolating untrusted input", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/proof-check.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /pull_request:\s+types: \[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /run: node scripts\/proof-check\/index.mjs/);
  assert.doesNotMatch(
    workflow,
    /continue-on-error|paths-ignore|pull_request_target|secrets\.|github\.event\./,
  );
});
