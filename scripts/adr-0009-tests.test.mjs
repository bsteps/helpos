import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const adr = readFileSync(join(root, "docs/adr/0009-tenant-isolation-extended.md"), "utf8");

const notBuiltYet = {
  "broadcaster drops events for other tenants":
    "realtime (the Broadcaster, ADR 0009 section 5) isn't built",
  "notify payload schema has no content fields":
    "realtime (the NOTIFY payload, ADR 0009 section 5) isn't built",
};

function namedTests(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("- Test:"))
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
}

function files(dir, keep) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", ".turbo"].includes(entry.name) ? [] : files(path, keep);
    }
    return keep(entry.name) ? [path] : [];
  });
}

const inRepo = (keep) => ["apps", "packages"].flatMap((d) => files(join(root, d), keep));
const testSources = inRepo((name) => name.endsWith(".test.ts")).map((p) => readFileSync(p, "utf8"));

const isWritten = (name) =>
  testSources.some((src) => [`"${name}"`, `'${name}'`, `\`${name}\``].some((q) => src.includes(q)));

const names = namedTests(adr);

test("the parser finds the tests the ADR names", () => {
  assert.ok(
    names.length > 10,
    `found only ${names.length} names: did the ADR's "- Test:" format change?`,
  );
  assert.ok(new Set(names).size === names.length, "a test is named twice in the ADR");
  assert.ok(
    testSources.length > 10,
    `found only ${testSources.length} test files under apps/ and packages/`,
  );
});

test("every test ADR 0009 names is written", () => {
  const missing = names.filter((n) => !(n in notBuiltYet) && !isWritten(n));
  assert.deepEqual(
    missing,
    [],
    "ADR 0009 names these tests, but no *.test.ts under apps/ or packages/ has the name as a " +
      'string (e.g. it("name", ...)). Restore the name, or write the test.',
  );
});

test("notBuiltYet lists only tests the ADR names, and none that exist already", () => {
  for (const name of Object.keys(notBuiltYet)) {
    assert.ok(
      names.includes(name),
      `"${name}" is not named in ADR 0009: remove it from notBuiltYet`,
    );
    assert.ok(!isWritten(name), `"${name}" is written now: remove it from notBuiltYet`);
  }
});

const sources = inRepo(
  (name) => /\.(?:ts|tsx|mts|sql)$/.test(name) && !/\.test\.(?:ts|tsx|mts)$/.test(name),
);

const notifyInCode = [
  /\bpg_notify\b/i,
  /\b(?:sql|client|pg|postgres|db|tx|pool|conn|connection)\s*\.\s*(?:listen|notify)\s*\(/,
  /["'`]\s*(?:LISTEN|NOTIFY)\s+[\w"$]/,
];
const notifyInSql = [/\bpg_notify\b/i, /^\s*(?:LISTEN|UNLISTEN|NOTIFY)\s/im];

const usesRealtime = (text, path) =>
  (path.endsWith(".sql") ? notifyInSql : notifyInCode).some((p) => p.test(text));

test("the realtime patterns match what they are meant to", () => {
  assert.ok(usesRealtime("select pg_notify('events', payload)", "a.ts"));
  assert.ok(usesRealtime("await sql.listen('events', handle)", "a.ts"));
  assert.ok(usesRealtime(`await tx.execute("NOTIFY events, 'x'")`, "a.ts"));
  assert.ok(usesRealtime("LISTEN events;", "a.sql"));
  assert.ok(!usesRealtime("server.listen(0, '127.0.0.1', done)", "a.ts"));
  assert.ok(!usesRealtime("// we notify the owner by email", "a.ts"));
  assert.ok(!usesRealtime("  notify the owner", "a.ts"));
});

test("nothing listens or notifies yet, so the two realtime tests stay in notBuiltYet", () => {
  const found = sources.filter((p) => usesRealtime(readFileSync(p, "utf8"), p));
  assert.deepEqual(
    found.map((p) => p.slice(root.length)),
    [],
    "realtime is here: write 'broadcaster drops events for other tenants' and " +
      "'notify payload schema has no content fields' (ADR 0009 section 5), then remove them " +
      "from notBuiltYet in scripts/adr-0009-tests.test.mjs",
  );
  assert.ok(sources.length > 50, `scanned only ${sources.length} source files`);
});
