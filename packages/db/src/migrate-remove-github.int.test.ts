import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { containerHost } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

let container: StartedPostgreSqlContainer;
let owner: postgres.Sql;
let ownerUrl: string;
let predecessor: string;
const tenantId = uuidv7();
const ids = {
  mailbox: uuidv7(),
  customer: uuidv7(),
  conversation: uuidv7(),
  answered: uuidv7(),
  latest: uuidv7(),
  sentReply: uuidv7(),
  sentFixed: uuidv7(),
  pendingReply: uuidv7(),
  pendingFixed: uuidv7(),
  mixedToken: uuidv7(),
  issueOnlyToken: uuidv7(),
  otherToken: uuidv7(),
};

beforeAll(async () => {
  predecessor = await mkdtemp(join(tmpdir(), "helpos-remove-github-migration-"));
  await cp(new URL("../migrations/", import.meta.url), predecessor, { recursive: true });
  const journalPath = join(predecessor, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 25);
  await writeFile(journalPath, JSON.stringify(journal));
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withCopyFilesToContainer([
      {
        source: fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url)),
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ])
    .start();
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
    for (const message of [ids.answered, ids.latest]) {
      await tx`insert into messages
        (id, tenant_id, conversation_id, direction, from_address, to_addresses, subject,
         text_body, message_id_header, "references", raw_file_key)
        values (${message}, ${tenantId}, ${ids.conversation}, 'inbound', 'customer@example.test',
          array['support@example.test'], 'Export broken', 'It fails',
          ${`<${message}@example.test>`}, array[]::text[], 'raw.eml')`;
    }
    await tx`insert into drafts (id, tenant_id, conversation_id, message_id, body, status, kind) values
      (${ids.sentReply}, ${tenantId}, ${ids.conversation}, ${ids.answered}, 'Looking into it', 'sent', 'reply'),
      (${ids.sentFixed}, ${tenantId}, ${ids.conversation}, ${ids.answered}, 'Fixed', 'sent', 'fixed'),
      (${ids.pendingReply}, ${tenantId}, ${ids.conversation}, ${ids.latest}, 'Thanks', 'pending', 'reply'),
      (${ids.pendingFixed}, ${tenantId}, ${ids.conversation}, ${ids.latest}, 'Fixed again', 'pending', 'fixed')`;
    await tx`insert into draft_citations
      (id, tenant_id, draft_id, title, visibility, excerpt, rank, cited)
      values (${uuidv7()}, ${tenantId}, ${ids.pendingFixed}, 'Export', 'public', 'Exports', 0, true)`;
    await tx`insert into api_tokens (id, tenant_id, name, token_hash, scopes) values
      (${ids.mixedToken}, ${tenantId}, 'mixed', ${"a".repeat(64)}, array['conversations:read', 'github:write']),
      (${ids.issueOnlyToken}, ${tenantId}, 'issue-only', ${"b".repeat(64)}, array['github:write']),
      (${ids.otherToken}, ${tenantId}, 'other', ${"c".repeat(64)}, array['drafts:write'])`;
    await tx`insert into integrations
      (tenant_id, id, provider, repo, token_ciphertext, webhook_secret_ciphertext)
      values (${tenantId}, ${uuidv7()}, 'github', 'acme/app', 'v1.sealed', 'v1.sealed')`;
    await tx`insert into conversation_github_issues
      (id, tenant_id, conversation_id, repo, issue_number, issue_url, state)
      values (${uuidv7()}, ${tenantId}, ${ids.conversation}, 'acme/app', 7,
        'https://example.test/issues/7', 'closed')`;
  });
}, 180_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await container?.stop();
  if (predecessor) await rm(predecessor, { recursive: true, force: true });
});

it("drops fixed notices, their citations and the github:write scope, keeping every reply", async () => {
  await runMigrations(ownerUrl);
  const after = await owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return {
      drafts: await tx<{ id: string; status: string }[]>`
        select id, status from drafts order by id`,
      citations: await tx`select id from draft_citations`,
      tokens: await tx<{ id: string; scopes: string[]; revoked: boolean }[]>`
        select id, scopes, revoked_at is not null as revoked from api_tokens order by name`,
    };
  });
  expect(after.drafts).toEqual(
    [
      { id: ids.sentReply, status: "sent" },
      { id: ids.pendingReply, status: "pending" },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(after.citations).toEqual([]);
  expect(after.tokens).toEqual([
    { id: ids.issueOnlyToken, scopes: ["conversations:read"], revoked: true },
    { id: ids.mixedToken, scopes: ["conversations:read"], revoked: false },
    { id: ids.otherToken, scopes: ["drafts:write"], revoked: false },
  ]);

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
