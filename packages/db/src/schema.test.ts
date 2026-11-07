import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

// Catalog checks against the migrated database (ADR 0003, ADR 0009 §6). They catch a
// migration that forgets RLS, adds an unsafe view, or adds an unreviewed SECURITY DEFINER.

let testDb: TestDatabase;
let owner: postgres.Sql;
let app: postgres.Sql;

beforeAll(async () => {
  testDb = await startTestDatabase();
  owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
  app = postgres(testDb.appUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await owner?.end();
  await app?.end();
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
      "audit_events",
      "customers",
      "drafts",
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

describe("audit_events is append-only for the app role", () => {
  const tenantId = "0190a000-0000-7000-8000-000000000001";

  /** Runs as the app role inside one tenant, like withTenant() does. */
  function asApp<T>(fn: (tx: postgres.TransactionSql) => Promise<T>) {
    return app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    await asApp(async (tx) => {
      await tx`insert into tenants (id, name) values (${tenantId}, 'audit')`;
      await tx`insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id)
        values (gen_random_uuid(), ${tenantId}, 'system', 'test', 'draft.created', 'draft', gen_random_uuid())`;
    });
  });

  it("can insert and read", async () => {
    const rows = await asApp((tx) => tx`select action from audit_events`);
    expect(rows.map((r) => r.action)).toEqual(["draft.created"]);
  });

  it.each([
    ["UPDATE", "update audit_events set action = 'forged'"],
    ["DELETE", "delete from audit_events"],
    ["TRUNCATE", "truncate audit_events"],
  ])("cannot %s", async (_, statement) => {
    await expect(asApp((tx) => tx.unsafe(statement))).rejects.toMatchObject({ code: "42501" });
  });
});
