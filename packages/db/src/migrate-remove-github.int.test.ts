import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withDevBootstrap } from "./dev-bootstrap.ts";
import { runMigrations } from "./migrate.ts";
import { containerHost } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

let container: StartedPostgreSqlContainer;
let owner: postgres.Sql;
let ownerUrl: string;
let predecessor: string;
const tenantId = uuidv7();
const revokedAt = new Date("2026-01-01T00:00:00Z");
const noticeSentAt = new Date("2026-01-02T00:00:00Z");
const ids = {
  mailbox: uuidv7(),
  customer: uuidv7(),
  conversation: uuidv7(),
  answered: uuidv7(),
  latest: uuidv7(),
  awaitingSend: uuidv7(),
  sentNoticeMessage: uuidv7(),
  sentReply: uuidv7(),
  sentFixed: uuidv7(),
  pendingReply: uuidv7(),
  approvedReply: uuidv7(),
  pendingFixed: uuidv7(),
  replyCitation: uuidv7(),
  mixedToken: uuidv7(),
  issueOnlyToken: uuidv7(),
  otherToken: uuidv7(),
  revokedToken: uuidv7(),
};

beforeEach(async () => {
  predecessor = await mkdtemp(join(tmpdir(), "helpos-remove-github-migration-"));
  await cp(new URL("../migrations/", import.meta.url), predecessor, { recursive: true });
  const journalPath = join(predecessor, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 25);
  await writeFile(journalPath, JSON.stringify(journal));
  container = await withDevBootstrap(new PostgreSqlContainer("pgvector/pgvector:pg17")).start();
  ownerUrl = `postgres://helpos_owner:helpos_owner@${containerHost(container)}:${container.getPort()}/helpos`;
  owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
  await migrate(drizzle(owner), { migrationsFolder: predecessor });
  await owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`insert into tenants (id, name) values (${tenantId}, 'migration fixture')`;
    await tx`insert into mailboxes (id, tenant_id, address)
      values (${ids.mailbox}, ${tenantId}, 'support@example.test')`;
    await tx`insert into customers (id, tenant_id, email)
      values (${ids.customer}, ${tenantId}, 'customer@example.test')`;
    await tx`insert into conversations (id, tenant_id, customer_id, mailbox_id, subject)
      values (${ids.conversation}, ${tenantId}, ${ids.customer}, ${ids.mailbox}, 'Export broken')`;
    for (const message of [ids.answered, ids.latest, ids.awaitingSend]) {
      await tx`insert into messages
        (id, tenant_id, conversation_id, direction, from_address, to_addresses, subject,
         text_body, message_id_header, "references", raw_file_key)
        values (${message}, ${tenantId}, ${ids.conversation}, 'inbound', 'customer@example.test',
          array['support@example.test'], 'Export broken', 'It fails',
          ${`<${message}@example.test>`}, array[]::text[], 'raw.eml')`;
    }
    await tx`insert into messages
      (id, tenant_id, conversation_id, direction, from_address, to_addresses, subject,
       text_body, message_id_header, "references", raw_file_key, sent_at)
      values (${ids.sentNoticeMessage}, ${tenantId}, ${ids.conversation}, 'outbound',
        'support@example.test', array['customer@example.test'], 'Export broken', 'Done',
        ${`<${ids.sentNoticeMessage}@example.test>`}, array[]::text[], 'outbound.eml', ${noticeSentAt.toISOString()})`;
    await tx`insert into drafts (id, tenant_id, conversation_id, message_id, body, status, kind) values
      (${ids.sentReply}, ${tenantId}, ${ids.conversation}, ${ids.answered}, 'Looking into it', 'sent', 'reply'),
      (${ids.sentFixed}, ${tenantId}, ${ids.conversation}, ${ids.answered}, 'Fixed', 'sent', 'fixed'),
      (${ids.pendingReply}, ${tenantId}, ${ids.conversation}, ${ids.latest}, 'Thanks', 'pending', 'reply'),
      (${ids.approvedReply}, ${tenantId}, ${ids.conversation}, ${ids.awaitingSend}, 'Approved reply', 'approved', 'reply'),
      (${ids.pendingFixed}, ${tenantId}, ${ids.conversation}, ${ids.latest}, 'Fixed again', 'pending', 'fixed')`;
    await tx`update drafts set sent_message_id = ${ids.sentNoticeMessage},
      sent_at = ${noticeSentAt.toISOString()} where id = ${ids.sentFixed}`;
    await tx`insert into draft_citations
      (id, tenant_id, draft_id, title, visibility, excerpt, rank, cited)
      values (${uuidv7()}, ${tenantId}, ${ids.pendingFixed}, 'Export', 'public', 'Exports', 0, true),
        (${ids.replyCitation}, ${tenantId}, ${ids.pendingReply}, 'Export', 'public', 'Exports', 0, true)`;
    await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes) values
      (${ids.mixedToken}, ${tenantId}, 'mixed', ${"a".repeat(64)}, array['drafts:write', 'github:write', 'stats:read']),
      (${ids.issueOnlyToken}, ${tenantId}, 'issue-only', ${"b".repeat(64)}, array['github:write']),
      (${ids.otherToken}, ${tenantId}, 'other', ${"c".repeat(64)}, array['drafts:write'])`;
    await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes, revoked_at)
      values (${ids.revokedToken}, ${tenantId}, 'revoked', ${"d".repeat(64)},
        array['github:write'], ${revokedAt.toISOString()})`;
    await tx`insert into integrations
      (tenant_id, id, provider, repo, token_ciphertext, webhook_secret_ciphertext)
      values (${tenantId}, ${uuidv7()}, 'github', 'acme/app', 'v1.sealed', 'v1.sealed')`;
    await tx`insert into conversation_github_issues
      (id, tenant_id, conversation_id, repo, issue_number, issue_url, state)
      values (${uuidv7()}, ${tenantId}, ${ids.conversation}, 'acme/app', 7,
        'https://example.test/issues/7', 'closed')`;
  });
}, 180_000);

afterEach(async () => {
  await owner?.end({ timeout: 5 });
  await container?.stop();
  if (predecessor) await rm(predecessor, { recursive: true, force: true });
});

it.each(["approved", "send_uncertain", "send_failed"])(
  "refuses retirement of %s notices until delivery is resolved",
  async (status) => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`update drafts set status = ${status} where id = ${ids.pendingFixed}`;
    });

    await expect(runMigrations(ownerUrl)).rejects.toThrow(/Resolve .* notices before upgrading/);

    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const drafts = await tx`select id, status, kind from drafts where id = ${ids.pendingFixed}`;
      expect(drafts).toEqual([{ id: ids.pendingFixed, status, kind: "fixed" }]);
      const citations = await tx`select id from draft_citations order by id`;
      expect(citations).toHaveLength(2);
      const [token] =
        await tx`select scopes, revoked_at from api_tokens where id = ${ids.issueOnlyToken}`;
      expect(token).toEqual({ scopes: ["github:write"], revoked_at: null });
    });

    const forced = await owner<{ relforcerowsecurity: boolean }[]>`
      select relforcerowsecurity from pg_class
      where relname in ('drafts', 'draft_citations', 'api_tokens')`;
    expect(forced.map((table) => table.relforcerowsecurity)).toEqual([true, true, true]);
  },
);

it("drops fixed notices, their citations and the github:write scope, keeping every reply", async () => {
  const before = await owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return {
      replies: await tx<{ row: unknown }[]>`
        select to_jsonb(drafts) - 'kind' as row from drafts where kind = 'reply' order by id`,
      citations: await tx<{ row: unknown }[]>`
        select to_jsonb(draft_citations) as row from draft_citations
        where draft_id = ${ids.pendingReply} order by id`,
      messages: await tx<
        { row: unknown }[]
      >`select to_jsonb(messages) as row from messages order by id`,
    };
  });
  await runMigrations(ownerUrl);
  const after = await owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return {
      drafts: await tx<{ id: string; status: string }[]>`
        select id, status from drafts order by id`,
      replies: await tx<{ row: unknown }[]>`select to_jsonb(drafts) as row from drafts order by id`,
      citations: await tx<{ row: unknown }[]>`
        select to_jsonb(draft_citations) as row from draft_citations order by id`,
      messages: await tx<
        { row: unknown }[]
      >`select to_jsonb(messages) as row from messages order by id`,
      tokens: await tx<{ id: string; scopes: string[]; revoked: boolean }[]>`
        select id, scopes, revoked_at is not null as revoked
        from api_tokens order by name`,
      revocation: await tx<{ unchanged: boolean }[]>`
        select revoked_at = ${revokedAt.toISOString()}::timestamptz as unchanged
        from api_tokens where id = ${ids.revokedToken}`,
    };
  });
  expect(after.drafts).toEqual(
    [
      { id: ids.sentReply, status: "sent" },
      { id: ids.pendingReply, status: "pending" },
      { id: ids.approvedReply, status: "approved" },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(after.replies).toEqual(before.replies);
  expect(after.citations).toEqual(before.citations);
  expect(after.messages).toEqual(before.messages);
  expect(after.tokens).toEqual([
    { id: ids.issueOnlyToken, scopes: ["conversations:read"], revoked: true },
    { id: ids.mixedToken, scopes: ["drafts:write", "stats:read"], revoked: false },
    { id: ids.otherToken, scopes: ["drafts:write"], revoked: false },
    { id: ids.revokedToken, scopes: ["conversations:read"], revoked: true },
  ]);
  expect(after.revocation).toEqual([{ unchanged: true }]);

  const tables = await owner<{ relname: string }[]>`
    select relname from pg_class
    where relname in ('integrations', 'conversation_github_issues')`;
  expect(tables).toEqual([]);
  const forced = await owner<{ relforcerowsecurity: boolean }[]>`
    select relforcerowsecurity from pg_class
    where relname in ('drafts', 'draft_citations', 'api_tokens')`;
  expect(forced.map((t) => t.relforcerowsecurity)).toEqual([true, true, true]);

  await expect(
    owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into drafts (id, tenant_id, conversation_id, message_id, body)
        values (${uuidv7()}, ${tenantId}, ${ids.conversation}, ${ids.latest}, 'A second live one')`;
    }),
  ).rejects.toThrow(/drafts_tenant_message_live/);
});
