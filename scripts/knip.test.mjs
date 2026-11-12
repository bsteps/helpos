import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/knip/bin/knip.js", import.meta.url));

test("Knip rejects unused package entry values and types even when source helpers are used", () => {
  const cwd = mkdtempSync(join(tmpdir(), "helpos-knip-"));
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
  try {
    copyFileSync(new URL("../knip.jsonc", import.meta.url), join(cwd, "knip.jsonc"));
    write("package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    const packages = ["ai", "db", "brand", "files", "safe-fetch"];
    for (const name of packages) {
      write(`packages/${name}/package.json`, JSON.stringify({ name, exports: "./src/index.ts" }));
      write(`packages/${name}/src/index.ts`, "export const used = 1;\n");
      write(`packages/${name}/src/helper.ts`, "export const helper = 2;\n");
      write(
        `scripts/${name}.mjs`,
        `import { used } from '../packages/${name}/src/index.ts';\nimport { helper } from '../packages/${name}/src/helper.ts';\nprocess.stdout.write(String(used + helper));\n`,
      );
    }
    const baseline = run();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    for (const name of packages) {
      write(
        `packages/${name}/src/index.ts`,
        "export const used = 1;\nexport { helper } from './helper.ts';\nexport type Unused = string;\n",
      );
    }
    const rejected = run();
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    for (const name of packages)
      assert.ok(rejected.stdout.includes(`packages/${name}/src/index.ts`));
    assert.match(rejected.stdout, /helper/);
    assert.match(rejected.stdout, /Unused/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
