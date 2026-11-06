import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

// Catalog checks against the migrated database (ADR 0003, ADR 0009 §6). They catch a
// migration that forgets RLS, adds an unsafe view, or adds an unreviewed SECURITY DEFINER.

let testDb: TestDatabase;
let owner: postgres.Sql;

beforeAll(async () => {
  testDb = await startTestDatabase();
  owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await owner?.end();
  await testDb?.container.stop();
});

describe("migrations", () => {
  it("every table with tenant_id has RLS enabled, forced and a tenant_isolation policy", async () => {
    const rows = await owner<
      { table: string; enabled: boolean; forced: boolean; policy: boolean }[]
    >`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = c.relname
                  and p.policyname = 'tenant_isolation') as policy
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`;
    expect(rows.map((r) => r.table)).toEqual([
      "attachments",
      "customers",
      "mailboxes",
      "memberships",
      "messages",
      "tickets",
    ]);
    for (const row of rows) {
      expect(row, row.table).toMatchObject({ enabled: true, forced: true, policy: true });
    }
  });

  it("every view is security_invoker", async () => {
    const unsafe = await owner<{ view: string }[]>`
      select c.relname as view from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
        and not coalesce('security_invoker=true' = any(c.reloptions), false)`;
    expect(unsafe).toEqual([]);
  });

  it("has SECURITY DEFINER functions only from the reviewed allowlist", async () => {
    const allowlist: unknown = JSON.parse(
      readFileSync(new URL("../security-definer-allowlist.json", import.meta.url), "utf8"),
    );
    const found = await owner<{ name: string }[]>`
      select n.nspname || '.' || p.proname as name from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`;
    for (const { name } of found) expect(allowlist).toContain(name);
    // Guards against the query silently finding nothing (e.g. jobs not installed).
    expect(found.map((f) => f.name)).toContain("jobs_api.app_enqueue");
  });
});
