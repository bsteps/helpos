// `pnpm test:scripts`: the import restrictions in biome.json stay in sync.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const config = JSON.parse(readFileSync(new URL("../biome.json", import.meta.url), "utf8"));
const restricted = (override) => override.linter?.rules?.style?.noRestrictedImports?.options?.paths;

// Biome replaces an override's noRestrictedImports options instead of merging them, so the one
// file that owns a restricted import restates every other restriction. Each owner here may drop
// only its own import; anything else it lacks has silently stopped applying to it.
const owners = {
  "apps/server/src/auth/access.ts": "@hono/zod-openapi",
  "apps/server/src/logger.ts": "pino",
};

const [base] = config.overrides.filter((o) => restricted(o) && o.includes.includes("**"));

test("the shared restriction list is found", () => {
  assert.ok(base, "no override with includes ['**', ...] and noRestrictedImports paths");
  for (const name of Object.values(owners)) assert.ok(name in restricted(base), name);
});

// Biome can't share the block (an override replaces it, and `extends` works only at the top), so
// the list is written once in `base` and each owner's copy is checked against it. Both guards
// below stop a copy from drifting: the list can't lose a ban everywhere at once, and no file
// outside `owners` may quietly get a copy of its own.
test("the shared list keeps every ban the architecture relies on", () => {
  const required = ["postgres", "drizzle-orm/postgres-js", "drizzle-orm", "pg-boss"];
  for (const name of [...required, ...Object.values(owners)]) {
    assert.ok(name in restricted(base), `biome.json no longer restricts imports of "${name}"`);
  }
});

test("only the shared list and the owners restate the restrictions", () => {
  const copies = config.overrides
    .filter((o) => restricted(o))
    .flatMap((o) => (o === base ? [] : o.includes));
  assert.deepEqual(
    copies.sort(),
    Object.keys(owners).sort(),
    "another override restates noRestrictedImports: add its file to `owners` here, or remove the copy",
  );
});

for (const [file, own] of Object.entries(owners)) {
  test(`${file} keeps every restriction except ${own}`, () => {
    const override = config.overrides.find(
      (o) => o.includes.length === 1 && o.includes[0] === file,
    );
    assert.ok(override, `biome.json has no override for ${file}`);
    const { [own]: _, ...expected } = restricted(base);
    assert.deepEqual(
      restricted(override),
      expected,
      `copy the shared paths from the first override into ${file}'s, minus "${own}"`,
    );
  });
}

for (const file of [
  `apps/server/src/line-limit-${process.pid}/routes.ts`,
  `apps/web/src/routes/line-limit-${process.pid}.tsx`,
]) {
  test(`${file} rejects more than 600 lines`, () => {
    const biome = fileURLToPath(
      new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url),
    );
    const fixture = mkdtempSync(join(tmpdir(), "helpos-biome-"));
    const path = join(fixture, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      join(fixture, "biome.json"),
      JSON.stringify({
        ...config,
        vcs: { enabled: false },
        plugins: config.plugins.map((plugin) =>
          fileURLToPath(new URL(`../${plugin}`, import.meta.url)),
        ),
      }),
    );
    try {
      for (const [lines, expected] of [
        [600, 0],
        [601, 1],
      ]) {
        writeFileSync(
          path,
          Array.from({ length: lines }, (_, i) => `export const line${i} = ${i};`).join("\n"),
        );
        const result = spawnSync(
          process.execPath,
          [biome, "lint", file, "--only=style/noExcessiveLinesPerFile", "--reporter=json"],
          {
            cwd: fixture,
            encoding: "utf8",
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, expected, result.stderr);
        const diagnostics = JSON.parse(result.stdout).diagnostics;
        assert.equal(
          diagnostics.filter((d) => d.category === "lint/style/noExcessiveLinesPerFile").length,
          expected,
        );
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
