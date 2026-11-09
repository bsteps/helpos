// `pnpm test:scripts`: the path → database/port derivation for parallel worktrees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  databaseSetupSql,
  defaults,
  isLocalDatabaseUrl,
  isolatedEnv,
  isolationFor,
  needsSeed,
  parseEnv,
} from "./worktree-env.mjs";

const wt = { isWorktree: true, platform: "linux" };
const localEnv = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));

test("the main checkout keeps the default database and ports", () => {
  const iso = isolationFor("/home/me/helpos", { isWorktree: false });
  assert.deepEqual(iso, { ...defaults, isolated: false });
  assert.deepEqual(isolatedEnv(localEnv, iso), { ok: true, env: {} });
});

test("the same path always gives the same values (stable across restarts)", () => {
  assert.deepEqual(isolationFor("/w/helpos/a", wt), isolationFor("/w/helpos/a", wt));
});

test("Windows paths match regardless of case, slashes and a trailing slash", () => {
  const win = { isWorktree: true, platform: "win32" };
  assert.deepEqual(
    isolationFor(String.raw`C:\Users\Me\wt\110-x`, win),
    isolationFor("c:/users/me/wt/110-x/", win),
  );
});

test("two worktrees get different databases and ports, none clashing with the defaults", () => {
  const a = isolationFor("/home/me/.t3/worktrees/helpos/110-worktree-setup", wt);
  const b = isolationFor("/home/me/.t3/worktrees/helpos/116-app-feature", wt);
  assert.notEqual(a.dbName, b.dbName);
  assert.notEqual(a.serverPort, b.serverPort);
  assert.notEqual(a.webPort, b.webPort);
  const ports = new Set([a.serverPort, a.webPort, b.serverPort, b.webPort]);
  assert.equal(ports.size, 4);
  for (const p of ports) {
    assert.ok(![defaults.serverPort, defaults.webPort, 5432, 1025, 8025].includes(p));
  }
});

test("database names are valid unquoted Postgres identifiers", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(isolationFor(`/wt/${i}`, wt).dbName, /^helpos_wt_[0-9a-f]{8}$/);
  }
});

test("a worktree's database URLs keep their role but use its own database", () => {
  const iso = isolationFor("/wt/a", wt);
  const result = isolatedEnv(localEnv, iso);
  assert.ok(result.ok);
  assert.equal(
    result.env.HELPOS_DATABASE_URL,
    `postgres://helpos_app:helpos_app@localhost:5432/${iso.dbName}`,
  );
  assert.equal(result.env.HELPOS_PORT, String(iso.serverPort));
  assert.equal(result.env.HELPOS_PUBLIC_URL, `http://localhost:${iso.webPort}`);
  assert.equal(result.env.HELPOS_API_URL, `http://localhost:${iso.serverPort}`);
});

test("a worktree never points at a non-local database", () => {
  const iso = isolationFor("/wt/a", wt);
  const remote = { HELPOS_DATABASE_URL: "postgres://u:p@db.example.com:5432/helpos" };
  assert.equal(isolatedEnv(remote, iso).ok, false);
  const sneaky = { HELPOS_DATABASE_URL: "postgres://u:p@localhost/helpos?host=db.example.com" };
  assert.equal(isolatedEnv(sneaky, iso).ok, false);
});

test("isLocalDatabaseUrl: this machine only", () => {
  for (const url of [
    "postgres://u:p@localhost:5432/helpos",
    "postgres://u:p@127.0.0.1/helpos",
    "postgres://u:p@[::1]:5432/helpos",
    "postgres:///helpos?host=/var/run/postgresql",
  ])
    assert.equal(isLocalDatabaseUrl(url), true, url);
  for (const url of [
    "postgres://u:p@db.example.com/helpos",
    "postgres://u:p@localhost/helpos?host=db.example.com",
    "postgres:///helpos?host=db.example.com",
    "postgres://u:p@localhost/helpos?hostaddr=10.0.0.5",
    "postgres:///helpos",
    "not a url",
    "",
  ])
    assert.equal(isLocalDatabaseUrl(url), false, url);
});

test("per-database setup matches docker/postgres/init.sql", () => {
  const init = readFileSync(new URL("../docker/postgres/init.sql", import.meta.url), "utf8");
  const statements = (sql) =>
    sql
      .split(";")
      .map((s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  const afterConnect = statements(init.split("connect helpos")[1]);
  assert.deepEqual(statements(databaseSetupSql()), afterConnect);
});

test("parseEnv reads quoted values, `export` and trailing comments like Node does", () => {
  const env = parseEnv(
    [
      'HELPOS_DATABASE_URL="postgres://a:b@localhost:5432/helpos"',
      "export HELPOS_DATABASE_OWNER_URL='postgres://o:o@localhost/helpos'",
      "HELPOS_PORT=3000 # the API",
      'HELPOS_SECRET="has # inside"',
      "# a comment line",
      "EMPTY=",
    ].join("\n"),
  );
  assert.deepEqual(env, {
    HELPOS_DATABASE_URL: "postgres://a:b@localhost:5432/helpos",
    HELPOS_DATABASE_OWNER_URL: "postgres://o:o@localhost/helpos",
    HELPOS_PORT: "3000",
    HELPOS_SECRET: "has # inside",
    EMPTY: "",
  });
  assert.ok(isolatedEnv({ ...localEnv, ...env }, isolationFor("/wt/a", wt)).ok);
});

test("a worktree refuses when a required database URL is missing", () => {
  const iso = isolationFor("/wt/a", wt);
  const { HELPOS_DATABASE_OWNER_URL: _, ...missing } = localEnv;
  const result = isolatedEnv(missing, iso);
  assert.equal(result.ok, false);
  const { HELPOS_DATABASE_AUTH_URL: __, ...noAuth } = localEnv;
  assert.ok(isolatedEnv(noAuth, iso).ok);
});

test("parseEnv takes only the first quoted value before a comment", () => {
  assert.deepEqual(parseEnv('A="a" # c "b"'), { A: "a" });
});

test("a worktree seeds a database it just created, even when the marker matches", () => {
  const iso = isolationFor("/wt/a", wt);
  const marker = `${iso.dbName}\n`;
  assert.equal(needsSeed({ isolation: iso, created: true, marker }), true);
  assert.equal(needsSeed({ isolation: iso, created: false, marker }), false);
  assert.equal(needsSeed({ isolation: iso, created: false, marker: "helpos_wt_other" }), true);
  assert.equal(needsSeed({ isolation: iso, created: false, marker: undefined }), true);
  const main = isolationFor("/main", { isWorktree: false });
  assert.equal(needsSeed({ isolation: main, created: false, marker: undefined }), false);
});
