import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

const migration = new URL("../migrations/0021_conversation-scopes-and-audit.sql", import.meta.url);

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

describe("migration 0021", () => {
  it("moves stored scopes and audit events to the conversation names", async () => {
    const tenantId = uuidv7();
    const closed = uuidv7();
    const drafted = uuidv7();
    await owner.unsafe(`alter table api_tokens drop constraint api_tokens_scopes;
      alter table api_tokens add constraint api_tokens_scopes
        check (scopes <@ array['tickets:read', 'tickets:write', 'drafts:write']::text[])`);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into tenants (id, name) values (${tenantId}, 'w')`;
      await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes) values
        (${uuidv7()}, ${tenantId}, 'old', ${"a".repeat(64)}, array['drafts:write', 'tickets:read', 'tickets:write']),
        (${uuidv7()}, ${tenantId}, 'other', ${"b".repeat(64)}, array['drafts:write'])`;
      await tx`insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id) values
        (${closed}, ${tenantId}, 'user', 'u', 'ticket.closed', 'ticket', ${uuidv7()}),
        (${drafted}, ${tenantId}, 'system', 'draft-reply', 'draft.created', 'draft', ${uuidv7()})`;
    });

    const statements = (await readFile(migration, "utf8")).split("--> statement-breakpoint");
    await owner.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });

    const { tokens, events } = await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return {
        tokens: await tx<{ name: string; scopes: string[] }[]>`
          select name, scopes from api_tokens order by name`,
        events: await tx<{ id: string; action: string; target_type: string }[]>`
          select id, action, target_type from audit_events order by action`,
      };
    });
    expect(tokens).toEqual([
      { name: "old", scopes: ["conversations:read", "conversations:write", "drafts:write"] },
      { name: "other", scopes: ["drafts:write"] },
    ]);
    expect(events).toEqual([
      { id: closed, action: "conversation.closed", target_type: "conversation" },
      { id: drafted, action: "draft.created", target_type: "draft" },
    ]);

    const forced = await owner<{ relname: string; relforcerowsecurity: boolean }[]>`
      select relname, relforcerowsecurity from pg_class
      where relname in ('api_tokens', 'audit_events') order by relname`;
    expect(forced.map((t) => t.relforcerowsecurity)).toEqual([true, true]);
    await expect(
      owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes)
          values (${uuidv7()}, ${tenantId}, 'new', ${"c".repeat(64)}, array['tickets:read'])`;
      }),
    ).rejects.toThrow(/api_tokens_scopes/);
  });
});
