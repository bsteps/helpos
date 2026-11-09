// `pnpm test:scripts`: the import restrictions in biome.json stay in sync.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
