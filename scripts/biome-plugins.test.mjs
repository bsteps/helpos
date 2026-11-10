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

function lint(source, name) {
  const file = `${dir}/${name}`;
  mkdirSync(new URL(`../${file}/..`, import.meta.url), { recursive: true });
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
  return JSON.parse(out).diagnostics;
}

function pluginMessages(source, name = "routes.ts") {
  return lint(source, name)
    .filter((d) => d.category === "plugin")
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
  "route-audit.grit (auditorFor)": [
    'export const f = (t, a) => auditorFor(t, a, "req");\n',
    /auditor\(c\)/,
  ],
  "draft-writes.grit": [
    'export const f = (tx) => tx.update(drafts).set({ status: "discarded" });\n',
    /drafts\/lifecycle\.ts/,
  ],
  "draft-writes.grit (insert into schema.drafts)": [
    "export const f = (tx, v) => tx.insert(schema.drafts).values(v);\n",
    /drafts\/lifecycle\.ts/,
  ],
};

const githubLookup = 'export const f = (tx) => tx.where(eq(integrations.provider, "github"));\n';
const githubOpen = "export const f = (box, sealed) => box.open(sealed, { tenantId, purpose });\n";
const githubIntegration = /github\/integration\.ts/;

for (const [plugin, [source, message]] of Object.entries(samples)) {
  test(`${plugin} reports a route file that uses the banned shape`, () => {
    const messages = pluginMessages(source);
    assert.ok(
      messages.some((m) => message.test(m)),
      `${plugin} no longer fires; got ${JSON.stringify(messages)}`,
    );
  });
}

test("github-integration.grit reports the integration lookup outside github/integration.ts", () => {
  const messages = pluginMessages(githubLookup, "github/webhook.ts");
  assert.ok(
    messages.some((m) => githubIntegration.test(m)),
    `no longer fires; got ${JSON.stringify(messages)}`,
  );
});

test("github-integration.grit reports opening a sealed secret outside github/integration.ts", () => {
  const messages = pluginMessages(githubOpen, "github/recheck.ts");
  assert.ok(
    messages.some((m) => githubIntegration.test(m)),
    `no longer fires; got ${JSON.stringify(messages)}`,
  );
});

test("github-integration.grit allows both in github/integration.ts itself", () => {
  assert.deepEqual(pluginMessages(githubLookup + githubOpen, "github/integration.ts"), []);
});

test("a route file past 600 lines is reported", () => {
  const long = Array.from(
    { length: 601 },
    (_, i) => `export const a${i} = ${i};
`,
  ).join("");
  const ids = lint(long, "routes.ts").map((d) => d.category);
  assert.ok(ids.includes("lint/style/noExcessiveLinesPerFile"), JSON.stringify(ids));
  // Other files are not held to the limit.
  assert.ok(!lint(long, "helpers.ts").some((d) => d.category.endsWith("noExcessiveLinesPerFile")));
});
