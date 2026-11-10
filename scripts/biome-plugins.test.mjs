// `pnpm test:scripts`: each Biome plugin in biome-plugins/ still fires on the shape it bans.
// The codebase has no copies left, so a plugin that silently stopped matching would look the
// same as one that works.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const biome = fileURLToPath(new URL("../node_modules/@biomejs/biome/bin/biome", import.meta.url));
const dir = `apps/server/src/lint-fixture-${process.pid}`;
mkdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true });
after(() => rmSync(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true }));

function pluginMessages(source) {
  const file = `${dir}/routes.ts`;
  writeFileSync(new URL(`../${file}`, import.meta.url), source);
  let out;
  try {
    out = execFileSync(process.execPath, [biome, "lint", file, "--reporter=json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    out = error.stdout;
  }
  return JSON.parse(out)
    .diagnostics.filter((d) => d.category === "plugin")
    .map((d) => String(d.message));
}

const samples = {
  "route-kit.grit": ["const errorSchema = 1;\nexport { errorSchema };\n", /route-kit\.ts instead/],
  "route-security.grit": [
    "export const r = { security: [{ apiAuth: [] }] };\n",
    /Delete `security`/,
  ],
  "route-not-found.grit": [
    'export const f = (c) => c.json({ error: "not_found" }, 404);\n',
    /notFound\(c\)/,
  ],
  "route-audit.grit": ["export const f = (tx, e) => recordAudit(tx, e);\n", /auditor\(c\)/],
};

for (const [plugin, [source, message]] of Object.entries(samples)) {
  test(`${plugin} reports a route file that uses the banned shape`, () => {
    const messages = pluginMessages(source);
    assert.ok(
      messages.some((m) => message.test(m)),
      `${plugin} no longer fires; got ${JSON.stringify(messages)}`,
    );
  });
}
