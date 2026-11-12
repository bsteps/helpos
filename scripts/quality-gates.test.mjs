import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("dashboard budget counts modulepreload chunks and rejects oversized initial JavaScript", () => {
  const fixture = mkdtempSync(join(tmpdir(), "dashboard-budget-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "dist/assets"), { recursive: true });
    copyFileSync(
      new URL("apps/web/scripts/check-budget.mjs", root),
      join(fixture, "scripts/check-budget.mjs"),
    );
    writeFileSync(
      join(fixture, "dist/index.html"),
      '<script src="/assets/index.js"></script><link rel="modulepreload" href="/assets/shared.js">',
    );
    writeFileSync(join(fixture, "dist/assets/index.js"), "export const ready = true;");
    writeFileSync(join(fixture, "dist/assets/shared.js"), "export const shared = true;");
    const run = () =>
      spawnSync(process.execPath, [join(fixture, "scripts/check-budget.mjs")], {
        encoding: "utf8",
      });
    assert.equal(run().status, 0);
    writeFileSync(join(fixture, "dist/assets/shared.js"), randomBytes(201 * 1024));
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Dashboard initial JS is over budget/);
    writeFileSync(join(fixture, "dist/index.html"), "<html></html>");
    assert.match(run().stderr, /found no scripts/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("quality commands run in the existing required check and failure artifacts include video output", () => {
  const ci = read(".github/workflows/ci.yml");
  const check = ci.split("\n  check:")[1]?.split("\n  e2e:")[0];
  assert.ok(check);
  for (const command of ["pnpm test:coverage", "pnpm check:widget", "pnpm test:performance"]) {
    assert.ok(
      check.includes(`- run: ${command}\n`),
      `${command} must be an unconditional required-check step`,
    );
  }
  const config = read("apps/web/playwright.config.ts");
  assert.match(config, /outputDir: "\.\/test-results"/);
  assert.match(config, /video: "retain-on-failure"/);
  const upload = ci
    .split("- name: Upload failure traces, screenshots and videos")[1]
    ?.split("\n  demo:")[0];
  assert.ok(upload);
  assert.match(upload, /if: failure\(\)/);
  assert.match(upload, /apps\/web\/test-results\//);
  assert.match(upload, /apps\/web\/playwright-report\//);
  assert.match(upload, /retention-days: 7/);
});
