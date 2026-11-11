import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/knip/bin/knip.js", import.meta.url));

test("Knip checks unused exports and types in drafts, outbound email and web", () => {
  const cwd = mkdtempSync(join(tmpdir(), "helpos-knip-apps-"));
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const run = () =>
    spawnSync(process.execPath, [cli, "--no-progress"], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
    });
  const paths = [
    "apps/server/src/drafts/probe.ts",
    "apps/server/src/outbound-email/probe.ts",
    "apps/web/src/probe.ts",
  ];
  try {
    copyFileSync(new URL("../knip.jsonc", import.meta.url), join(cwd, "knip.jsonc"));
    write("package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    for (const name of ["server", "web"]) {
      write(`apps/${name}/package.json`, JSON.stringify({ name, private: true }));
    }
    for (const path of paths) write(path, "export const used = 1;\n");
    write(
      "apps/server/src/worker.ts",
      "import { used as a } from './drafts/probe.ts';\nimport { used as b } from './outbound-email/probe.ts';\nconsole.log(a, b);\n",
    );
    write(
      "apps/web/scripts/probe.mjs",
      "import { used } from '../src/probe.ts';\nconsole.log(used);\n",
    );
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    for (const path of paths) {
      write(
        path,
        "export const used = 1;\nexport const unusedValue = 2;\nexport type UnusedType = string;\n",
      );
    }
    const rejected = run();
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    for (const path of paths) {
      for (const symbol of ["unusedValue", "UnusedType"]) {
        assert.ok(
          rejected.stdout.split("\n").some((line) => line.includes(path) && line.includes(symbol)),
          rejected.stdout,
        );
      }
    }
    for (const path of paths) write(path, "export const used = 1;\n");
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
