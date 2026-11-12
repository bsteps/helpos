import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import type { AuthStore } from "./auth.ts";
import type { Database } from "./client.ts";
import { installJobs } from "./jobs.ts";
import { runMigrations } from "./migrate.ts";
import {
  aiUsage,
  apiTokens,
  attachments,
  auditEvents,
  conversationGithubIssues,
  conversations,
  customers,
  draftCitations,
  drafts,
  httpIdempotency,
  integrations,
  knowledgeChunks,
  knowledgeEmbeddingDimensions,
  knowledgeSources,
  mailboxes,
  memberships,
  messages,
  tenants,
} from "./schema.ts";
import { uuidv7 } from "./uuid.ts";

const initSql = fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url));

/** Set by the test global setup: the shared Postgres that test files make their databases in. */
const sharedServerEnv = "HELPOS_TEST_POSTGRES";

export interface TestDatabase {
  /** URL for the app role (no BYPASSRLS), same as the server uses. */
  appUrl: string;
  ownerUrl: string;
  /** URL for the auth role, the only one that can use the `auth` schema (ADR 0009). */
  authUrl: string;
  /** URL for the jobs role, owner of the `pgboss` schema. */
  jobsUrl: string;
  /** Drops the database, or stops its container when it has one of its own. */
  stop(): Promise<void>;
}

function urls(hostPort: string, database: string) {
  const url = (role: string) => `postgres://${role}:${role}@${hostPort}/${database}`;
  return {
    ownerUrl: url("helpos_owner"),
    appUrl: url("helpos_app"),
    authUrl: url("helpos_auth"),
    jobsUrl: url("helpos_jobs"),
  };
}

/**
 * A throwaway Postgres with the same image, roles and migrations as local dev, so tests
 * exercise real SQL and real RLS (ADR 0005). Its migrated `helpos` database is the template
 * that each test database is copied from.
 */
async function startServer(): Promise<{ container: StartedPostgreSqlContainer; adminUrl: string }> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withCopyFilesToContainer([{ source: initSql, target: "/docker-entrypoint-initdb.d/init.sql" }])
    // A throwaway database: durability only costs disk writes.
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "shared_buffers=64MB",
      "-c",
      "max_connections=300",
    ])
    .start();
  const hostPort = hostPortOf(container);
  const { ownerUrl, jobsUrl } = urls(hostPort, "helpos");
  try {
    await runMigrations(ownerUrl);
    await installJobs(jobsUrl);
  } catch (error) {
    // Nothing else gets the container to stop, so stop it here rather than leave it running
    // until Testcontainers' reaper notices.
    await container.stop();
    throw error;
  }
  const admin = `${encodeURIComponent(container.getUsername())}:${encodeURIComponent(container.getPassword())}`;
  return { container, adminUrl: `postgres://${admin}@${hostPort}/postgres` };
}

/**
 * A test container's host, as IPv4. Testcontainers says `localhost`, which Node tries as `::1`
 * first, and Docker Desktop's IPv6 port forwarding stalls new connections while other
 * containers are busy: half of 50 Postgres connections hit CONNECT_TIMEOUT, and SMTP
 * connections to Mailpit waited 15 s, where 127.0.0.1 took under 150 ms for both.
 */
export function containerHost(container: { getHost(): string }): string {
  const host = container.getHost();
  return host === "localhost" ? "127.0.0.1" : host;
}

function hostPortOf(container: StartedPostgreSqlContainer): string {
  return `${containerHost(container)}:${container.getPort()}`;
}

/**
 * Vitest global setup: starts one Postgres for the whole run, so test files don't each
 * start a container. Starting many at once overloads Docker, and their databases time out.
 */
export async function setup(): Promise<() => Promise<void>> {
  const { container, adminUrl } = await startServer();
  process.env[sharedServerEnv] = adminUrl;
  return async () => {
    await container.stop();
  };
}

/**
 * A fresh, migrated database of its own for one test file. In a test run it is a copy of the
 * shared server's template, which takes a fraction of a second. Outside one (the e2e server),
 * it starts its own container.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env[sharedServerEnv];
  if (!adminUrl) {
    const { container } = await startServer();
    return {
      ...urls(hostPortOf(container), "helpos"),
      stop: async () => {
        await container.stop();
      },
    };
  }
  const database = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${database} template helpos owner helpos_owner`);
  } finally {
    await admin.end();
  }
  return {
    ...urls(new URL(adminUrl).host, database),
    stop: async () => {
      const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        // FORCE: a test that forgot to close a pool must not leave its database behind.
        await sql.unsafe(`drop database if exists ${database} with (force)`);
      } finally {
        await sql.end();
      }
    },
  };
}

export const leakEmbeddingAxis = 7;
export const leakEmbeddingModel = "test/model";
export const leakFixtureDay = "2026-11-07";

export function unitVector(axis: number): number[] {
  const v = new Array<number>(knowledgeEmbeddingDimensions).fill(0);
  v[axis] = 1;
  return v;
}

export interface LeakTenant {
  tenantId: string;
  tag: string;
  ownerUserId: string;
  tokenHash: string;
  tokenName: string;
  mailboxAddress: string;
  customerEmail: string;
  messageIdHeader: string;
  sourceSlug: string;
  ids: {
    mailbox: string;
    membership: string;
    customer: string;
    conversation: string;
    message: string;
    attachment: string;
    draft: string;
    aiUsage: string;
    source: string;
    chunk: string;
    citation: string;
    token: string;
    integration: string;
    githubIssue: string;
    auditEvent: string;
  };
}

export async function seedLeakTenant(
  db: Pick<Database, "withTenant">,
  auth: Pick<AuthStore, "ensureUser">,
  input: {
    tenantId: string;
    tag: string;
    inputTokens?: number;
    draftStatus?: "pending" | "discarded";
  },
): Promise<LeakTenant> {
  const { tenantId, tag } = input;
  const user = await auth.ensureUser(`owner@${tag}.test`);
  const seeded: LeakTenant = {
    tenantId,
    tag,
    ownerUserId: user.id,
    tokenHash: createHash("sha256").update(`${tag}:${tenantId}`).digest("hex"),
    tokenName: `${tag}-bot`,
    mailboxAddress: `support@${tag}.test`,
    customerEmail: `jane@${tag}-customer.test`,
    messageIdHeader: `<message@${tag}-customer.test>`,
    sourceSlug: `${tag}-refunds`,
    ids: {
      mailbox: uuidv7(),
      membership: uuidv7(),
      customer: uuidv7(),
      conversation: uuidv7(),
      message: uuidv7(),
      attachment: uuidv7(),
      draft: uuidv7(),
      aiUsage: uuidv7(),
      source: uuidv7(),
      chunk: uuidv7(),
      citation: uuidv7(),
      token: uuidv7(),
      integration: uuidv7(),
      githubIssue: uuidv7(),
      auditEvent: uuidv7(),
    },
  };
  const { ids } = seeded;
  const repo = `${tag}-corp/app`;
  await db.withTenant(tenantId, async (tx) => {
    await tx
      .insert(tenants)
      .values({ id: tenantId, name: `${tag} workspace`, shadowRecipient: `owner@${tag}.test` });
    await tx
      .insert(mailboxes)
      .values({ id: ids.mailbox, tenantId, address: seeded.mailboxAddress });
    await tx
      .insert(memberships)
      .values({ id: ids.membership, tenantId, userId: user.id, role: "owner" });
    await tx.insert(customers).values({
      id: ids.customer,
      tenantId,
      email: seeded.customerEmail,
      name: `${tag} customer`,
    });
    await tx.insert(conversations).values({
      id: ids.conversation,
      tenantId,
      customerId: ids.customer,
      mailboxId: ids.mailbox,
      subject: `${tag} question`,
    });
    await tx.insert(messages).values({
      id: ids.message,
      tenantId,
      conversationId: ids.conversation,
      direction: "inbound",
      fromAddress: seeded.customerEmail,
      fromName: `${tag} customer`,
      toAddresses: [seeded.mailboxAddress],
      subject: `${tag} question`,
      textBody: `${tag} needs help with a refund`,
      references: [],
      rawFileKey: `${tenantId}/raw`,
      messageIdHeader: seeded.messageIdHeader,
    });
    await tx.insert(attachments).values({
      id: ids.attachment,
      tenantId,
      messageId: ids.message,
      filename: `${tag}.txt`,
      contentType: "text/plain",
      sizeBytes: 1,
      fileKey: `${tenantId}/file`,
    });
    await tx.insert(drafts).values({
      id: ids.draft,
      tenantId,
      conversationId: ids.conversation,
      messageId: ids.message,
      body: `Hi from ${tag}`,
      status: input.draftStatus ?? "pending",
      createdAt: new Date(`${leakFixtureDay}T00:00:00Z`),
    });
    await tx.insert(aiUsage).values({
      id: ids.aiUsage,
      tenantId,
      day: leakFixtureDay,
      inputTokens: input.inputTokens ?? 10,
    });
    await tx.insert(knowledgeSources).values({
      id: ids.source,
      tenantId,
      slug: seeded.sourceSlug,
      kind: "markdown",
      title: `${tag} refund policy`,
      content: `${tag} refunds take 5 days.`,
    });
    await tx.insert(knowledgeChunks).values({
      id: ids.chunk,
      tenantId,
      sourceId: ids.source,
      position: 0,
      content: `${tag} refunds take 5 days.`,
      embedding: unitVector(leakEmbeddingAxis),
      embeddingModel: leakEmbeddingModel,
    });
    await tx.insert(draftCitations).values({
      id: ids.citation,
      tenantId,
      draftId: ids.draft,
      sourceId: ids.source,
      title: `${tag} refund policy`,
      visibility: "internal",
      excerpt: `${tag} refunds take 5 days.`,
      rank: 0,
      cited: true,
    });
    await tx.insert(apiTokens).values({
      id: ids.token,
      tenantId,
      name: seeded.tokenName,
      tokenHash: seeded.tokenHash,
      scopes: ["conversations:read"],
    });
    await tx.insert(httpIdempotency).values({
      tenantId,
      actorType: "agent",
      actorId: ids.token,
      keyHash: `${tag}-key-hash`,
      fingerprint: `${tag}-fingerprint`,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    await tx.insert(integrations).values({
      id: ids.integration,
      tenantId,
      provider: "github",
      repo,
      tokenCiphertext: `v1.${tag}-sealed-token`,
      webhookSecretCiphertext: `v1.${tag}-sealed-secret`,
    });
    await tx.insert(conversationGithubIssues).values({
      id: ids.githubIssue,
      tenantId,
      conversationId: ids.conversation,
      repo,
      issueNumber: 7,
      issueUrl: `https://github.com/${repo}/issues/7`,
      state: "open",
    });
    await tx.insert(auditEvents).values({
      id: ids.auditEvent,
      tenantId,
      actorType: "system",
      actorId: `${tag}-draft-reply`,
      action: "draft.created",
      targetType: "draft",
      targetId: ids.draft,
    });
  });
  return seeded;
}

export async function tenantSnapshot(
  ownerUrl: string,
  tenantId: string,
): Promise<Record<string, unknown[]>> {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      const tables = await tx<{ table: string; ownerColumn: string | null }[]>`
        select c.relname as table,
          case when exists (select 1 from pg_attribute a where a.attrelid = c.oid
                              and a.attname = 'tenant_id' and not a.attisdropped) then 'tenant_id'
               when c.relname = 'tenants' then 'id' end as "ownerColumn"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
        order by c.relname`;
      const snapshot: Record<string, unknown[]> = {};
      for (const { table, ownerColumn } of tables) {
        if (!ownerColumn) {
          throw new Error(
            `${table} has no tenant_id: add one, or teach tenantSnapshot() which column owns its rows`,
          );
        }
        const rows = await tx<{ row: unknown }[]>`
          select to_jsonb(t) as row from ${tx(table)} t
          where ${tx(ownerColumn)} = ${tenantId}
          order by to_jsonb(t)::text`;
        snapshot[table] = rows.map((r) => r.row);
      }
      return snapshot;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function uncoveredTables(snapshot: Record<string, unknown[]>): string[] {
  return Object.entries(snapshot)
    .filter(([, rows]) => rows.length === 0)
    .map(([table]) => table);
}

export async function expireTestSendJob(jobsUrl: string, draftId: string): Promise<void> {
  const db = postgres(jobsUrl);
  const boss = new PgBoss({
    connectionString: jobsUrl,
    createSchema: false,
    migrate: false,
    schedule: false,
  });
  try {
    await db`update pgboss.job set started_on = now() - interval '1 hour', expire_seconds = 1 where name = 'send-reply' and data->>'draftId' = ${draftId} and state = 'active'`;
    await boss.start();
    await boss.supervise("send-reply");
  } finally {
    await boss.stop();
    await db.end();
  }
}
