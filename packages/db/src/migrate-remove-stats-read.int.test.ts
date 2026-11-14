import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

const migration = new URL("../migrations/0027_remove-stats-read.sql", import.meta.url);

let testDb: TestDatabase;
let owner: postgres.Sql;

beforeAll(async () => {
  testDb = await startTestDatabase();
  owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await testDb?.stop();
});

describe("migration 0027", () => {
  it("strips stats:read from tokens and revokes the ones left without a scope", async () => {
    const tenantId = uuidv7();
    const revokedAt = new Date("2026-01-01T00:00:00Z");
    await owner.unsafe(`alter table api_tokens drop constraint api_tokens_scopes;
      alter table api_tokens add constraint api_tokens_scopes
        check (scopes <@ array['conversations:read', 'drafts:write', 'knowledge:read', 'stats:read']::text[])`);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into tenants (id, name) values (${tenantId}, 'w')`;
      await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes) values
        (${uuidv7()}, ${tenantId}, 'mixed', ${"a".repeat(64)}, array['drafts:write', 'stats:read', 'knowledge:read']),
        (${uuidv7()}, ${tenantId}, 'stats-only', ${"b".repeat(64)}, array['stats:read']),
        (${uuidv7()}, ${tenantId}, 'other', ${"c".repeat(64)}, array['drafts:write'])`;
      await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes, revoked_at)
        values (${uuidv7()}, ${tenantId}, 'revoked', ${"d".repeat(64)}, array['stats:read'],
          ${revokedAt.toISOString()})`;
    });

    const statements = (await readFile(migration, "utf8")).split("--> statement-breakpoint");
    await owner.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });

    const tokens = await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tx<{ name: string; scopes: string[]; revoked: boolean; revokedKept: boolean }[]>`
        select name, scopes, revoked_at is not null as revoked,
          coalesce(revoked_at = ${revokedAt.toISOString()}::timestamptz, false) as "revokedKept"
        from api_tokens order by name`;
    });
    expect(tokens).toEqual([
      {
        name: "mixed",
        scopes: ["drafts:write", "knowledge:read"],
        revoked: false,
        revokedKept: false,
      },
      { name: "other", scopes: ["drafts:write"], revoked: false, revokedKept: false },
      { name: "revoked", scopes: ["conversations:read"], revoked: true, revokedKept: true },
      { name: "stats-only", scopes: ["conversations:read"], revoked: true, revokedKept: false },
    ]);

    const forced = await owner<{ relforcerowsecurity: boolean }[]>`
      select relforcerowsecurity from pg_class where relname = 'api_tokens'`;
    expect(forced).toEqual([{ relforcerowsecurity: true }]);
    await expect(
      owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes)
          values (${uuidv7()}, ${tenantId}, 'new', ${"e".repeat(64)}, array['stats:read'])`;
      }),
    ).rejects.toThrow(/api_tokens_scopes/);
  });
});
