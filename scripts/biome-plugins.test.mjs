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

function lint(source, name, directory = dir) {
  const file = `${directory}/${name}`;
  mkdirSync(new URL(`../${file}/..`, import.meta.url), { recursive: true });
  writeFileSync(new URL(`../${file}`, import.meta.url), source);
  let out;
  try {
    out = execFileSync(process.execPath, [biome, "lint", file, "--reporter=json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (error) {
    out = error.stdout;
  }
  return JSON.parse(out).diagnostics;
}

function pluginMessages(source, name = "routes.ts") {
  const diagnostics = lint(source, name);
  assert.ok(
    !diagnostics.some((d) => String(d.message).includes("errored:")),
    JSON.stringify(diagnostics),
  );
  return diagnostics.filter((d) => d.category === "plugin").map((d) => String(d.message));
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
  "ai-usage.grit (a write to ai_usage)": [
    "export const f = (tx) => tx.update(schema.aiUsage).set({ inputTokens: 1 });\n",
    /aiBudget\(\)/,
  ],
  "ai-usage.grit (a helper that records outside the reservation)": [
    'export const f = (tx, t) => recordUsage(tx, t, "2026-11-10", { inputTokens: 1 });\n',
    /aiBudget\(\)/,
  ],
};

test("domain modules cannot import HTTP values or types", () => {
  for (const source of [
    'import type { Auditor } from "../http/route-kit.ts";\n',
    'import { json } from "../http/route-kit.ts";\n',
    'export { json } from "../http/route-kit.ts";\n',
    'export type { Auditor } from "../http/route-kit.ts";\n',
    'export * from "../http/route-kit.ts";\n',
    'export * as kit from "../http/route-kit.ts";\n',
    'import "../http/route-kit.ts";\n',
    'export const kit = await import("../http/route-kit.ts");\n',
  ]) {
    for (const name of [
      "drafts/lifecycle.ts",
      "knowledge/ingest-worker.ts",
      "ai-budget/set-budget.ts",
      "conversations/lifecycle.ts",
    ]) {
      assert.ok(pluginMessages(source, name).some((m) => m.includes("Domain modules")));
    }
  }
});

test("HTTP adapters can import HTTP helpers and domain modules can import audit types", () => {
  const source = 'import { json } from "../http/route-kit.ts";\n';
  for (const name of [
    "routes.ts",
    "route.ts",
    "shadow-mode-routes.ts",
    "http/helpers.ts",
    "auth/access.ts",
    "apps/server/src/app.ts",
    "domain.test.ts",
  ]) {
    assert.ok(!pluginMessages(source, name).some((m) => m.includes("Domain modules")), name);
  }
  assert.ok(
    !pluginMessages(
      'import type { Auditor } from "../audit/audit.ts";\n',
      "drafts/lifecycle.ts",
    ).some((m) => m.includes("Domain modules")),
  );
});

for (const [plugin, [source, message]] of Object.entries(samples)) {
  test(`${plugin} reports a route file that uses the banned shape`, () => {
    const messages = pluginMessages(source);
    assert.ok(
      messages.some((m) => message.test(m)),
      `${plugin} no longer fires; got ${JSON.stringify(messages)}`,
    );
  });
}

test("ai-usage.grit allows ai_usage writes only inside ai-budget/", () => {
  const write = "export const f = (tx) => tx.insert(aiUsage).values({ tenantId, day });\n";
  assert.deepEqual(pluginMessages(write, "ai-budget/budget.ts"), []);
  const lookalike = pluginMessages(write, "workspaces/ai-budget.ts");
  assert.ok(lookalike.some((m) => /aiBudget\(\)/.test(m)));
  const elsewhere = pluginMessages(write, "knowledge/ingest-worker.ts");
  assert.ok(
    elsewhere.some((m) => /aiBudget\(\)/.test(m)),
    `no longer fires; got ${JSON.stringify(elsewhere)}`,
  );
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
for (const source of [
  "export function f() { try { work(); } catch {} }",
  "export function f() { try { work(); } catch (error) {} }",
  "export function f() { try { work(); } catch { /* ignored */ } }",
]) {
  test(`empty catch is rejected: ${source}`, () => {
    assert.ok(pluginMessages(source, "helper.mjs").some((m) => /empty catch/.test(m)));
  });
}
test("intentional no-op callbacks and handled errors are allowed", () => {
  assert.deepEqual(
    pluginMessages(
      "export const f = () => {}; export function g() { try { work(); } catch { return false; } }",
      "helper.mjs",
    ),
    [],
  );
});
for (const read of [
  ...["json", "text", "parseBody", "formData", "arrayBuffer", "blob"].map((m) => `req.${m}`),
  ...["json", "text", "formData", "arrayBuffer", "blob"].map((m) => `req.raw.${m}`),
]) {
  test(`raw request ${read} is rejected outside the raw routes`, () => {
    assert.ok(
      pluginMessages(`export const f = (ctx) => ctx.${read}();`, "handler.ts").some((m) =>
        /req.valid/.test(m),
      ),
    );
  });
}
test("validated request and response body reads are allowed", () => {
  assert.deepEqual(
    pluginMessages(
      'export const f = (c, response) => [c.req.valid("json"), c.req.raw.headers, response.json()];',
    ),
    [],
  );
});
test("hardcoded display name is rejected", () => {
  assert.ok(
    pluginMessages('export const title = "HelpOS";').some((m) => /product display name/.test(m)),
  );
});
test("brand imports and test display strings are allowed", () => {
  assert.deepEqual(
    pluginMessages('import { brand } from "@helpos/brand"; export const title = brand.name;'),
    [],
  );
  assert.deepEqual(pluginMessages('export const title = "HelpOS";', "brand.test.ts"), []);
});
test("filenames must be kebab case", () => {
  assert.ok(
    lint("export const a = 1;", "BadName.ts").some(
      (d) => d.category === "lint/style/useFilenamingConvention",
    ),
  );
  assert.ok(
    !lint("export const a = 1;", "good-name.test.ts").some(
      (d) => d.category === "lint/style/useFilenamingConvention",
    ),
  );
});

test("raw body owner is allowed: apps/server/src/inbound-email/route.ts", () => {
  const diagnostics = lint(
    "export const f = (c) => c.req.arrayBuffer();",
    "apps/server/src/inbound-email/route.ts",
  );
  assert.deepEqual(
    diagnostics.filter((d) => d.category === "plugin"),
    [],
  );
});
for (const path of [
  "apps/server/src/copy/inbound-email/route.ts",
  "apps/server/src/handler.test.ts",
]) {
  test(`raw body lookalike is rejected: ${path}`, () => {
    assert.ok(
      lint("export const f = (c) => c.req.json();", path).some((d) => /req.valid/.test(d.message)),
    );
  });
}
for (const source of [
  'export const title = "Welcome to HelpOS";',
  "export const title = 'HelpOS';",
  "export const title = `HelpOS ${" + "version}`;",
  'export const title = <h1 title="HelpOS">HelpOS</h1>;',
]) {
  test(`brand text is rejected: ${source}`, () => {
    assert.ok(pluginMessages(source, "title.tsx").some((m) => /product display name/.test(m)));
  });
}
test("only the brand package defines the display name", () => {
  assert.deepEqual(
    lint('export const name = "HelpOS";', "packages/brand/src/index.ts").filter(
      (d) => d.category === "plugin",
    ),
    [],
  );
  assert.ok(
    lint('export const name = "HelpOS";', "packages/files/src/brand/index.ts").some((d) =>
      /product display name/.test(d.message),
    ),
  );
});
test("comments and package identifiers are not display strings", () => {
  assert.deepEqual(pluginMessages('// HelpOS\nexport const name = "@helpos/brand";'), []);
});
test("empty catches are checked in verification scripts too", () => {
  const directory = ".claude/skills/verify-helpos/scripts";
  const name = `lint-fixture-${process.pid}.mjs`;
  try {
    assert.ok(
      lint("try { work(); } catch {}", name, directory).some((d) => /empty catch/.test(d.message)),
    );
  } finally {
    rmSync(new URL(`../${directory}/${name}`, import.meta.url), { force: true });
  }
});

for (const source of [
  'import { generateText } from "ai"; export { generateText };',
  'import type { LanguageModel } from "ai"; export type { LanguageModel };',
  'export * from "ai";',
  'export * as sdk from "ai";',
  'export type * as sdk from "ai";',
  'export { generateText } from "ai";',
  'export const sdk = import("ai");',
  'export const sdk = require("ai");',
  'import { MockLanguageModelV4 } from "ai/test"; export { MockLanguageModelV4 };',
  'import { createOpenAI } from "@ai-sdk/openai"; export { createOpenAI };',
  'import { withPaidModels } from "@helpos/ai/budget"; export { withPaidModels };',
  'export * as budgetAccess from "@helpos/ai/budget";',
  'export type * as budgetAccess from "@helpos/ai/budget";',
]) {
  test(`paid AI boundary rejects ${source}`, () => {
    assert.ok(pluginMessages(source).some((m) => m.includes("AI SDK imports belong")));
  });
}

test("paid AI boundary allows the public helpers", () => {
  assert.deepEqual(
    pluginMessages('import { draftReply } from "@helpos/ai"; export { draftReply };'),
    [],
  );
});

const conversationWriteMessage = /conversations\/lifecycle\.ts/;
for (const table of ["conversations", "messages", "schema.conversations", "schema.messages"]) {
  for (const operation of ["insert", "update", "delete"]) {
    test(`conversation-writes.grit rejects ${operation}(${table}) in every caller`, () => {
      const source = `export const f = (tx) => tx.${operation}(${table});\n`;
      for (const file of [
        "routes.ts",
        "inbound-email/ingest.ts",
        "drafts/send-worker.ts",
        "seed/seed.ts",
        "conversations/other.ts",
        "workspaces/lifecycle.ts",
      ]) {
        assert.ok(
          pluginMessages(source, file).some((m) => conversationWriteMessage.test(m)),
          file,
        );
      }
      assert.deepEqual(pluginMessages(source, "conversations/lifecycle.ts"), []);
      assert.deepEqual(pluginMessages(source, "conversations/lifecycle.int.test.ts"), []);
    });
  }
}

test("conversation-writes.grit allows reads and unrelated table writes", () => {
  assert.deepEqual(
    pluginMessages(
      "export const f = (tx) => tx.select().from(conversations);\n",
      "inbound-email/ingest.ts",
    ),
    [],
  );
  assert.deepEqual(
    pluginMessages("export const f = (tx) => tx.update(customers);\n", "inbound-email/ingest.ts"),
    [],
  );
});
