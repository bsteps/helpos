import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenScopes } from "./schema.ts";
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
  await testDb?.stop();
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
      "ai_usage",
      "api_tokens",
      "attachments",
      "audit_events",
      "conversation_github_issues",
      "conversations",
      "customers",
      "draft_citations",
      "drafts",
      "http_idempotency",
      "integrations",
      "knowledge_chunks",
      "knowledge_sources",
      "mailboxes",
      "memberships",
      "messages",
    ]);
    for (const row of rows) {
      expect(row, row.table).toMatchObject({ enabled: true, forced: true, policy: true });
    }
  });

  // The check above only sees tables with a tenant_id column, so a table keyed some other way
  // (the tenants table itself, #47) slipped past it. Every public table needs RLS; one without
  // tenant_id is listed here with the reason, and still needs RLS and a policy.
  const withoutTenantId: Record<string, string> = {
    tenants: "the workspace row itself: its policy matches id, not tenant_id",
  };

  it("every public table has RLS forced and a policy; ones without tenant_id say why", async () => {
    const rows = await owner<
      { table: string; tenantId: boolean; enabled: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname as table,
        exists (select 1 from pg_attribute a where a.attrelid = c.oid
                  and a.attname = 'tenant_id' and not a.attisdropped) as "tenantId",
        c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`;
    const fix =
      "add ENABLE and FORCE ROW LEVEL SECURITY and a policy in the migration " +
      "(see packages/db/migrations/0001_tenants-rls.sql)";
    for (const row of rows) {
      expect(row.enabled && row.forced && row.policies > 0, `${row.table}: ${fix}`).toBe(true);
      if (!row.tenantId) {
        expect(
          withoutTenantId[row.table],
          `${row.table} has no tenant_id: add tenant_id, or list it in withoutTenantId with why`,
        ).toBeDefined();
      }
    }
    expect(rows.filter((r) => !r.tenantId).map((r) => r.table)).toEqual(
      Object.keys(withoutTenantId),
    );
  });

  it("migrations: every view is security_invoker", async () => {
    const unsafe = await owner<{ view: string }[]>`
      select c.relname as view from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
        and not coalesce('security_invoker=true' = any(c.reloptions), false)`;
    expect(unsafe).toEqual([]);
  });

  it("migrations: SECURITY DEFINER only in allowlist", async () => {
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

describe("api_tokens: the app role can only create and revoke", () => {
  const tenantId = "0190a000-0000-7000-8000-000000000002";
  const hash = "a".repeat(64);

  function asApp<T>(fn: (tx: postgres.TransactionSql) => Promise<T>) {
    return app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    await asApp(async (tx) => {
      await tx`insert into tenants (id, name) values (${tenantId}, 'tokens')`;
      await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes)
        values (gen_random_uuid(), ${tenantId}, 'bot', ${hash}, array['conversations:read'])`;
    });
  });

  it("can revoke", async () => {
    const rows = await asApp(
      (tx) => tx`update api_tokens set revoked_at = now() returning revoked_at`,
    );
    expect(rows).toHaveLength(1);
  });

  it.each([
    ["rewrite a hash", `update api_tokens set token_hash = '${"b".repeat(64)}'`],
    ["widen scopes", "update api_tokens set scopes = array['drafts:approve']"],
    ["move a token to another workspace", "update api_tokens set tenant_id = gen_random_uuid()"],
    ["delete", "delete from api_tokens"],
    ["truncate", "truncate api_tokens"],
  ])("cannot %s", async (_, statement) => {
    await expect(asApp((tx) => tx.unsafe(statement))).rejects.toMatchObject({ code: "42501" });
  });

  it("the migrated CHECK allows exactly apiTokenScopes (a new scope needs `pnpm --filter @helpos/db generate`)", async () => {
    const [row] = await owner<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'api_tokens_scopes'`;
    const allowed = [...(row?.def ?? "").matchAll(/'([a-z]+:[a-z]+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...apiTokenScopes].sort());
  });

  it.each([
    ["an unknown scope", "array['workspace:admin']", "c"],
    ["no scopes", "array[]::text[]", "d"],
  ])("refuses a token with %s", async (_, scopes, fill) => {
    await expect(
      asApp((tx) =>
        tx.unsafe(`insert into api_tokens (id, tenant_id, name, token_hash, scopes)
          values (gen_random_uuid(), '${tenantId}', 'bot', '${fill.repeat(64)}', ${scopes})`),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
