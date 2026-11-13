import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { containerHost } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

let container: StartedPostgreSqlContainer;
let owner: postgres.Sql;
let ownerUrl: string;
let predecessor: string;
const tenantIds = [uuidv7(), uuidv7()];

beforeEach(async () => {
  predecessor = await mkdtemp(join(tmpdir(), "helpos-uncertain-migration-"));
  await cp(new URL("../migrations/", import.meta.url), predecessor, { recursive: true });
  const journalPath = join(predecessor, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 22);
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
  for (const tenantId of tenantIds) {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`insert into tenants (id, name) values (${tenantId}, 'migration fixture')`;
      const mailbox = uuidv7();
      const customer = uuidv7();
      const conversation = uuidv7();
      await tx`insert into mailboxes (id, tenant_id, address)
        values (${mailbox}, ${tenantId}, ${`${mailbox}@example.test`})`;
      await tx`insert into customers (id, tenant_id, email)
        values (${customer}, ${tenantId}, 'customer@example.test')`;
      await tx`insert into conversations (id, tenant_id, customer_id, mailbox_id, subject)
        values (${conversation}, ${tenantId}, ${customer}, ${mailbox}, 'Retained subject')`;
      for (const status of ["pending", "approved", "sent", "send_failed", "discarded"]) {
        const message = uuidv7();
        await tx`insert into messages
          (id, tenant_id, conversation_id, direction, from_address, to_addresses, subject,
           text_body, message_id_header, "references", raw_file_key)
          values (${message}, ${tenantId}, ${conversation}, 'inbound', 'customer@example.test',
            array['support@example.test'], 'Retained subject', 'Retained email',
            ${`<${message}@example.test>`}, array[]::text[], 'retained.eml')`;
        await tx`insert into drafts
          (id, tenant_id, conversation_id, message_id, body, status, outbound_message_id_header)
          values (${uuidv7()}, ${tenantId}, ${conversation}, ${message}, 'Retained reply',
            ${status}, ${`<reply-${message}@example.test>`})`;
      }
      await tx`insert into knowledge_sources (id, tenant_id, slug, kind, title, content, state, retry_count)
        values (${uuidv7()}, ${tenantId}, 'retained', 'markdown', 'Retained article', 'Retained content',
          '{"status":"waiting","reason":{"code":"network"},"retryAt":"2027-01-01T00:00:00Z"}', 1)`;
    });
  }
});

afterEach(async () => {
  await owner?.end({ timeout: 5 });
  await container?.stop();
  if (predecessor) await rm(predecessor, { recursive: true, force: true });
});

async function rows(tenantId: string) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return {
      drafts: await tx`select * from drafts order by id`,
      messages: await tx`select * from messages order by id`,
      knowledge: await tx`select * from knowledge_sources order by id`,
    };
  });
}

it("migrates the typed-state predecessor without changing either tenant's stored replies or knowledge", async () => {
  const before = await Promise.all(tenantIds.map(rows));
  await runMigrations(ownerUrl);
  for (const [index, tenantId] of tenantIds.entries()) {
    const after = await rows(tenantId);
    expect(after).toEqual({
      ...before[index],
      drafts: before[index]?.drafts.map(({ kind: _kind, ...draft }) => ({
        ...draft,
        resend_requested: false,
      })),
    });
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`update drafts set status = 'send_uncertain', resend_requested = true where status = 'approved'`;
      const uncertain =
        await tx`select status, resend_requested from drafts where status = 'send_uncertain'`;
      expect(uncertain).toEqual([{ status: "send_uncertain", resend_requested: true }]);
    });
  }
});

it("rolls back the column and journal entry if the expanded status constraint cannot be installed", async () => {
  await owner`alter table drafts drop constraint drafts_status`;
  for (const tenantId of tenantIds) {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      await tx`update drafts set status = 'invalid' where status = 'approved'`;
    });
  }
  await owner`alter table drafts add constraint drafts_status
    check (status in ('pending', 'approved', 'sent', 'send_failed', 'discarded')) not valid`;
  const before = await Promise.all(tenantIds.map(rows));
  const journal = await owner`select * from drizzle.__drizzle_migrations order by id`;
  await expect(runMigrations(ownerUrl)).rejects.toMatchObject({
    cause: { code: "23514", constraint_name: "drafts_status" },
  });
  expect(await Promise.all(tenantIds.map(rows))).toEqual(before);
  expect(await owner`select * from drizzle.__drizzle_migrations order by id`).toEqual(journal);
  expect(
    await owner`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'drafts' and column_name = 'resend_requested'`,
  ).toEqual([]);
});
