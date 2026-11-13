import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createVitest } from "vitest/node";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("combined coverage keeps unit isolation and server response contracts in both projects", async () => {
  const ctx = await createVitest({
    root: fileURLToPath(root),
    config: "vitest.coverage.config.mts",
    watch: false,
    coverage: { enabled: false },
  });
  try {
    const specs = await ctx.globTestSpecifications();
    const paths = specs.map((spec) => spec.moduleId.replaceAll("\\", "/"));
    assert.equal(new Set(paths).size, paths.length, "each test file runs once");
    for (const name of ["apps/server:unit", "apps/server:int"]) {
      const project = ctx.projects.find((project) => project.name === name);
      assert.ok(project);
      assert.ok(project.config.setupFiles.some((path) => path.endsWith("/src/testing/setup.ts")));
      assert.equal(project.config.globalSetup.length, name.endsWith(":int") ? 1 : 0);
    }
    for (const path of [
      "web/dashboard.int.test.ts",
      "http/pagination.int.test.ts",
      "app.int.test.ts",
      "knowledge/knowledge.int.test.ts",
    ]) {
      const spec = specs.find((spec) => spec.moduleId.replaceAll("\\", "/").endsWith(path));
      assert.equal(spec?.project.name, "apps/server:int", path);
    }
    const contract = specs.find((spec) => spec.moduleId.endsWith("/testing/contract.test.ts"));
    assert.equal(contract?.project.name, "apps/server:unit");
    const config = read("vitest.coverage.config.mts");
    assert.ok(config.includes('"apps/*/src/**/*.{ts,tsx}"'));
    assert.ok(config.includes('"packages/*/src/**/*.ts"'));
    assert.ok(config.includes('"apps/server/src/**/testing.ts"'));
  } finally {
    await ctx.close();
  }
});

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
  for (const command of ["pnpm test:coverage", "pnpm test:performance"]) {
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
