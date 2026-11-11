// `pnpm test:scripts`: the import restrictions in biome.json stay in sync.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
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

const biome = fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url));
const fixtureRoot = mkdtempSync(fileURLToPath(new URL("../lint-outbound-", import.meta.url)));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function outboundDiagnostics(source, file) {
  const target = join(fixtureRoot, file);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, source);
  const result = spawnSync(process.execPath, [biome, "lint", target, "--reporter=json"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const diagnostics = JSON.parse(result.stdout).diagnostics;
  assert.ok(!diagnostics.some((d) => d.category.startsWith("parse")), JSON.stringify(diagnostics));
  assert.ok(
    !diagnostics.some((d) => d.category === "plugin" && d.severity === "info"),
    JSON.stringify(diagnostics),
  );
  return diagnostics.filter(
    (d) => d.category === "plugin" && String(d.message).includes("Use @helpos/safe-fetch"),
  );
}

const rawRequests = [
  'fetch("https://example.com");',
  "export const request = fetch;",
  'fetch("https://example.com", { method: "POST" });',
  "export let request = fetch;",
  "export var request = fetch;",
  "request = fetch;",
  "export const request = () => fetch;",
  "sendWith(fetch);",
  'globalThis.fetch("https://example.com");',
  'window.fetch("/v1/tickets");',
  'global.fetch("https://example.com");',
  'globalThis["fetch"]("https://example.com");',
  'window["fetch"]("/v1/tickets");',
  'global["fetch"]("https://example.com");',
  ...["globalThis", "window", "global"].flatMap((global) => [
    `const { fetch: send } = ${global}; send("https://example.com");`,
    `${global}[\`fetch\`]("https://example.com");`,
  ]),
  'let { location, fetch: send } = globalThis; send("https://example.com");',
  'var { fetch: send, location } = globalThis; send("https://example.com");',
  'let send; ({ fetch: send } = globalThis); send("https://example.com");',
  'const { "fetch": send } = globalThis; send("https://example.com");',
  ...["undici", "node:http", "node:https", "http", "https"].flatMap((module) => [
    `import transport from "${module}"; export { transport };`,
    `import { request as send } from '${module}'; export { send };`,
    `import * as transport from "${module}"; export { transport };`,
    `import "${module}";`,
    `export { request } from "${module}";`,
    `export * from "${module}";`,
    `export const transport = import("${module}");`,
    `export const transport = require("${module}");`,
  ]),
];

for (const file of [
  "apps/server/src/outbound-fixture.ts",
  "packages/ai/src/outbound-fixture.ts",
  "packages/db/src/outbound-fixture.ts",
  "apps/web/src/outbound-fixture.tsx",
  "apps/web/src/other/api/client.ts",
  "packages/safe-fetch-copy/src/outbound-fixture.ts",
]) {
  test(`raw outbound requests are rejected in ${file}`, () => {
    for (const source of rawRequests) {
      assert.ok(outboundDiagnostics(source, file).length > 0, `${file}: ${source}`);
    }
  });
}

for (const file of [
  "packages/safe-fetch/src/fetch.ts",
  "apps/web/src/api/client.ts",
  "apps/server/src/outbound.test.ts",
  "apps/web/src/outbound.test.tsx",
  "packages/ai/src/outbound.spec.ts",
  "apps/server/src/e2e/serve.ts",
  "scripts/outbound-fixture.mjs",
]) {
  test(`raw outbound requests remain available in ${file}`, () => {
    for (const source of rawRequests) {
      assert.deepEqual(outboundDiagnostics(source, file), [], `${file}: ${source}`);
    }
  });
}

test("typed and injected clients remain valid", () => {
  const source = `
    import { safeFetch } from "@helpos/safe-fetch";
    export const load = (deps, url) => deps.fetch(url);
    export const handle = (app, req) => app.fetch(req);
    export const injected = (deps) => { const { fetch: send } = deps; return send; };
    export type Transport = typeof fetch;
    export { safeFetch };
  `;
  assert.deepEqual(outboundDiagnostics(source, "apps/server/src/outbound-fixture.ts"), []);
  assert.deepEqual(
    outboundDiagnostics(
      'import { api } from "./api/client.ts"; api.GET("/v1/me");',
      "apps/web/src/outbound-fixture.ts",
    ),
    [],
  );
});
