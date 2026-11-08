// `pnpm test:scripts`: the path → database/port derivation for parallel worktrees.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  databaseSetupSql,
  defaults,
  isolatedEnv,
  isolationFor,
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
