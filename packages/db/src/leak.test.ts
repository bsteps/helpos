import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthStore, createAuthStore } from "./auth.ts";
import { createDatabase, type Database, type TenantTx } from "./client.ts";
import { isUniqueViolation, sqlState } from "./errors.ts";
import { searchKnowledge } from "./knowledge.ts";
import {
  apiTokens,
  conversations,
  customers,
  draftCitations,
  drafts,
  knowledgeChunks,
  knowledgeSources,
  mailboxes,
  memberships,
  messages,
  tenants,
} from "./schema.ts";
import {
  type LeakTenant,
  leakEmbeddingAxis,
  leakEmbeddingModel,
  seedLeakTenant,
  startTestDatabase,
  type TestDatabase,
  tenantSnapshot,
  uncoveredTables,
  unitVector,
} from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let b: LeakTenant;

const insufficientPrivilege = "42501";
const tenantA = uuidv7();
const tenantB = uuidv7();

const dataModelDoc = new URL("../../../docs/architecture/data-model.md", import.meta.url);

/** A minimal conversation in tenant A, so A-side tests have something valid to point at. */
async function seedConversationInA(tx: TenantTx, address: string) {
  const ids = { mailbox: uuidv7(), customer: uuidv7(), conversation: uuidv7() };
  await tx.insert(mailboxes).values({ id: ids.mailbox, tenantId: tenantA, address });
  await tx.insert(customers).values({ id: ids.customer, tenantId: tenantA, email: address });
  await tx.insert(conversations).values({
    id: ids.conversation,
    tenantId: tenantA,
    customerId: ids.customer,
    mailboxId: ids.mailbox,
    subject: "x",
  });
  return ids;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  b = await seedLeakTenant(db, auth, { tenantId: tenantB, tag: "leak-b" });
  await db.withTenant(tenantA, (tx) => tx.insert(tenants).values({ id: tenantA, name: "a" }));
});

afterAll(async () => {
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("leak: every public table, acting as tenant A", () => {
  const ownerColumn = (table: string) => (table === "tenants" ? "id" : "tenant_id");

  const asA = <T>(fn: (tx: TenantTx) => Promise<T>) => db.withTenant(tenantA, fn);
  const asB = <T>(fn: (tx: TenantTx) => Promise<T>) => db.withTenant(tenantB, fn);

  async function countOwned(
    run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>,
    table: string,
  ): Promise<number> {
    const column = sql.identifier(ownerColumn(table));
    const [row] = await run((tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)} where ${column} = ${tenantB}::uuid`,
      ),
    );
    return row?.n ?? -1;
  }

  async function write(kind: "update" | "delete", table: string) {
    const t = sql.identifier(table);
    const c = sql.identifier(ownerColumn(table));
    const statement =
      kind === "update"
        ? sql`update ${t} set ${c} = ${c} where ${c} = ${tenantB}::uuid`
        : sql`delete from ${t} where ${c} = ${tenantB}::uuid`;
    // Its own transaction: a refused statement aborts the one it ran in.
    return asA((tx) =>
      tx.execute<{ n: number }>(
        sql`with changed as (${statement} returning 1) select count(*)::int as n from changed`,
      ),
    ).then(
      (rows) => ({ changed: rows[0]?.n ?? -1 }),
      (error: unknown) => ({ refused: sqlState(error) }),
    );
  }

  it("every table has a row for tenant B, so the checks below can't pass on nothing", async () => {
    const snapshot = await tenantSnapshot(testDb.ownerUrl, tenantB);
    expect(
      uncoveredTables(snapshot),
      "these tables have no row in the seeded tenant: add one for each in seedLeakTenant (packages/db/src/testing.ts)",
    ).toEqual([]);
  });

  it("can't read B's rows in any table, while B can", async () => {
    const snapshot = await tenantSnapshot(testDb.ownerUrl, tenantB);
    expect(Object.keys(snapshot).length).toBeGreaterThan(10);
    for (const table of Object.keys(snapshot)) {
      expect(await countOwned(asA, table), `${table}: A sees B's rows`).toBe(0);
      expect(await countOwned(asB, table), `${table}: B sees none of its own rows`).toBeGreaterThan(
        0,
      );
    }
  });

  it("can't update or delete B's rows in any table, and B's data is unchanged", async () => {
    const before = await tenantSnapshot(testDb.ownerUrl, tenantB);
    for (const table of Object.keys(before)) {
      for (const kind of ["update", "delete"] as const) {
        const outcome = await write(kind, table);
        const ok =
          "refused" in outcome ? outcome.refused === insufficientPrivilege : outcome.changed === 0;
        expect(ok, `${table}: A's ${kind} of B's rows gave ${JSON.stringify(outcome)}`).toBe(true);
      }
    }
    expect(await tenantSnapshot(testDb.ownerUrl, tenantB)).toEqual(before);
  });

  it("is told when a table has no row in the seeded tenant", async () => {
    const owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      await owner`create table leak_fixture_uncovered (id uuid primary key, tenant_id uuid not null)`;
      try {
        const snapshot = await tenantSnapshot(testDb.ownerUrl, tenantB);
        expect(uncoveredTables(snapshot)).toEqual(["leak_fixture_uncovered"]);
      } finally {
        await owner`drop table leak_fixture_uncovered`;
      }
    } finally {
      await owner.end({ timeout: 5 });
    }
  });

  it("has every table described in docs/architecture/data-model.md", async () => {
    const doc = readFileSync(dataModelDoc, "utf8");
    const snapshot = await tenantSnapshot(testDb.ownerUrl, tenantB);
    const undocumented = Object.keys(snapshot).filter((table) => !doc.includes(`\`${table}\``));
    expect(
      undocumented,
      "document each of these tables in docs/architecture/data-model.md, with its name in backticks",
    ).toEqual([]);
  });
});

describe("leak: acting as tenant A", () => {
  it("cannot revoke B's api_tokens", async () => {
    const revoked = await db.withTenant(tenantA, (tx) =>
      tx.update(apiTokens).set({ revokedAt: new Date() }).returning(),
    );
    expect(revoked).toEqual([]);
    expect((await db.resolveApiToken(b.tokenHash))?.revokedAt).toBeNull();
  });

  it("cannot insert a row tagged with B's tenant_id", async () => {
    await expect(
      db.withTenant(tenantA, (tx) =>
        tx.insert(customers).values({ tenantId: tenantB, email: "x@customer.test" }),
      ),
    ).rejects.toThrow();
  });

  it("cannot point a message at B's conversation, even with its ID", async () => {
    await expect(
      db.withTenant(tenantA, async (tx) => {
        await seedConversationInA(tx, "fk@a.test");
        await tx.insert(messages).values({
          tenantId: tenantA,
          conversationId: b.ids.conversation,
          direction: "inbound",
          fromAddress: "x@c.test",
          toAddresses: [],
          subject: "x",
          references: [],
          rawFileKey: "k",
        });
      }),
    ).rejects.toThrow();
  });

  it("leak: vector search as A returns no B embeddings", async () => {
    const hits = await db.withTenant(tenantA, (tx) =>
      searchKnowledge(tx, {
        tenantId: tenantA,
        embedding: unitVector(leakEmbeddingAxis),
        embeddingModel: leakEmbeddingModel,
        limit: 20,
      }),
    );
    expect(hits).toEqual([]);
  });

  it("vector search as A returns nothing even when it asks for B's tenant_id", async () => {
    // The explicit filter is belt and braces: RLS alone already refuses B's rows.
    const hits = await db.withTenant(tenantA, (tx) =>
      searchKnowledge(tx, {
        tenantId: tenantB,
        embedding: unitVector(leakEmbeddingAxis),
        embeddingModel: leakEmbeddingModel,
        limit: 20,
      }),
    );
    expect(hits).toEqual([]);
    const own = await db.withTenant(tenantB, (tx) =>
      searchKnowledge(tx, {
        tenantId: tenantB,
        embedding: unitVector(leakEmbeddingAxis),
        embeddingModel: leakEmbeddingModel,
        limit: 20,
      }),
    );
    expect(own.map((h) => h.chunkId)).toEqual([b.ids.chunk]);
  });

  it("cannot attach B's knowledge chunk to a source in A, even with its ID", async () => {
    await expect(
      db.withTenant(tenantA, async (tx) => {
        const [source] = await tx
          .insert(knowledgeSources)
          .values({ tenantId: tenantA, slug: "x", kind: "markdown", title: "x", content: "x" })
          .returning({ id: knowledgeSources.id });
        await tx.insert(knowledgeChunks).values({
          tenantId: tenantA,
          sourceId: b.ids.source,
          position: 0,
          content: `x${source?.id}`,
          embedding: unitVector(1),
          embeddingModel: leakEmbeddingModel,
        });
      }),
    ).rejects.toThrow();
  });

  it("cannot point a draft's citation at B's knowledge source, even with its ID", async () => {
    const rollback = new Error("rollback");
    await expect(
      db.withTenant(tenantA, async (tx) => {
        const ids = await seedConversationInA(tx, "cite@a.test");
        const messageId = uuidv7();
        const draftId = uuidv7();
        await tx.insert(messages).values({
          id: messageId,
          tenantId: tenantA,
          conversationId: ids.conversation,
          direction: "inbound",
          fromAddress: "cite@a.test",
          toAddresses: ["cite@a.test"],
          subject: "x",
          references: [],
          rawFileKey: `${tenantA}/raw-cite`,
          messageIdHeader: "<cite@a.test>",
        });
        await tx.insert(drafts).values({
          id: draftId,
          tenantId: tenantA,
          conversationId: ids.conversation,
          messageId,
          body: "x",
        });
        const citation = {
          tenantId: tenantA,
          draftId,
          title: "x",
          visibility: "internal" as const,
          excerpt: "x",
          cited: false,
        };
        // Without a source the same row is fine, so the source is what gets refused.
        await tx.insert(draftCitations).values({ ...citation, sourceId: null, rank: 0 });
        await expect(
          tx.transaction((sp) =>
            sp.insert(draftCitations).values({ ...citation, sourceId: b.ids.source, rank: 1 }),
          ),
        ).rejects.toSatisfy((e: unknown) =>
          /draft_citations_source_fk/.test(String(e instanceof Error ? (e.cause ?? e) : e)),
        );
        // Leaves A's tables empty for the other tests.
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("a knowledge slug that B already uses is accepted in A", async () => {
    await db.withTenant(tenantA, (tx) =>
      tx.insert(knowledgeSources).values({
        tenantId: tenantA,
        slug: b.sourceSlug,
        kind: "url",
        title: "A's refunds",
        url: "https://a.test/refunds",
      }),
    );
  });

  it("fetching B's conversation ID finds nothing, same as an unknown ID", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, b.ids.conversation)),
    );
    expect(rows).toEqual([]);
  });

  it("leak: creating a customer with B's email succeeds in A", async () => {
    await db.withTenant(tenantA, (tx) =>
      tx.insert(customers).values({ tenantId: tenantA, email: b.customerEmail }),
    );
    const mine = await db.withTenant(tenantA, (tx) =>
      tx.select().from(customers).where(eq(customers.email, b.customerEmail)),
    );
    expect(mine).toHaveLength(1);
  });

  it("a Message-ID that B already has is accepted in A", async () => {
    // Per-tenant uniqueness: no error tells A that B received this email.
    await db.withTenant(tenantA, async (tx) => {
      const ids = await seedConversationInA(tx, "mid@a.test");
      await tx.insert(messages).values({
        tenantId: tenantA,
        conversationId: ids.conversation,
        direction: "inbound",
        fromAddress: "m@c.test",
        toAddresses: [],
        subject: "x",
        references: [],
        rawFileKey: "k",
        messageIdHeader: b.messageIdHeader,
      });
    });
  });
});

describe("mailbox routing", () => {
  it("resolves an address to its tenant, case-insensitively", async () => {
    expect(await db.resolveMailbox(` ${b.mailboxAddress.toUpperCase()} `)).toEqual({
      tenantId: tenantB,
      mailboxId: b.ids.mailbox,
    });
  });

  it("returns null for an unknown address", async () => {
    expect(await db.resolveMailbox("nobody@nowhere.test")).toBeNull();
  });

  it("shows only the asked-for mailbox, never the others", async () => {
    const rows = await db.withTenant(uuidv7(), async (tx) => {
      await tx.execute(sql`select set_config('app.mailbox_address', ${b.mailboxAddress}, true)`);
      return tx.select().from(mailboxes);
    });
    expect(rows.map((r) => r.address)).toEqual([b.mailboxAddress]);
  });

  it("reports a taken address as a unique violation, without saying who owns it", async () => {
    const error = await db
      .withTenant(tenantA, (tx) =>
        tx.insert(mailboxes).values({ tenantId: tenantA, address: b.mailboxAddress }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isUniqueViolation(error, "mailboxes_address")).toBe(true);
  });
});

describe("agent token lookup", () => {
  it("resolves a hash to its token and workspace", async () => {
    expect(await db.resolveApiToken(b.tokenHash)).toEqual({
      id: b.ids.token,
      tenantId: tenantB,
      name: b.tokenName,
      tokenHash: b.tokenHash,
      scopes: ["conversations:read"],
      revokedAt: null,
    });
  });

  it("returns null for an unknown or malformed hash", async () => {
    expect(await db.resolveApiToken("c".repeat(64))).toBeNull();
    expect(await db.resolveApiToken("")).toBeNull();
    expect(await db.resolveApiToken(b.tokenHash.toUpperCase())).toBeNull();
  });

  it("shows only the asked-for token, never the others", async () => {
    await db.withTenant(tenantA, (tx) =>
      tx.insert(apiTokens).values({
        tenantId: tenantA,
        name: "a-bot",
        tokenHash: "a".repeat(64),
        scopes: ["conversations:read"],
      }),
    );
    const rows = await db.withTenant(uuidv7(), async (tx) => {
      await tx.execute(sql`select set_config('app.token_hash', ${b.tokenHash}, true)`);
      return tx.select().from(apiTokens);
    });
    expect(rows.map((r) => r.id)).toEqual([b.ids.token]);
  });

  it("the hash policy only reads: it can't revoke B's token", async () => {
    const revoked = await db.withTenant(tenantA, async (tx) => {
      await tx.execute(sql`select set_config('app.token_hash', ${b.tokenHash}, true)`);
      return tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(eq(apiTokens.id, b.ids.token))
        .returning();
    });
    expect(revoked).toEqual([]);
    expect((await db.resolveApiToken(b.tokenHash))?.revokedAt).toBeNull();
  });
});

describe("auth tables", () => {
  it("leak: auth tables are not readable by the app role", async () => {
    for (const table of ["users", "sessions", "accounts", "verifications"]) {
      await expect(
        db.withTenant(tenantA, (tx) =>
          tx.execute(sql`select * from ${sql.identifier("auth")}.${sql.identifier(table)}`),
        ),
        `auth.${table}`,
      ).rejects.toThrow();
    }
  });

  it("leak: memberships lists only my own rows across tenants", async () => {
    const other = await auth.ensureUser("someone@a.test");
    await db.withTenant(tenantA, (tx) =>
      tx.insert(memberships).values({ tenantId: tenantA, userId: other.id, role: "member" }),
    );
    expect(await db.listMemberships(b.ownerUserId)).toEqual([{ tenantId: tenantB, role: "owner" }]);
    expect(await db.listMemberships(other.id)).toEqual([{ tenantId: tenantA, role: "member" }]);
  });

  it("leak: a user of B has no membership when acting as A", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, b.ownerUserId)),
    );
    expect(rows).toEqual([]);
  });

  it("ensureUser is idempotent and normalises case", async () => {
    expect((await auth.ensureUser("Owner@Leak-B.test")).id).toBe(b.ownerUserId);
  });

  it("emailsOf returns only the emails of the IDs given", async () => {
    expect(await auth.emailsOf([b.ownerUserId])).toEqual(["owner@leak-b.test"]);
    expect(await auth.emailsOf([])).toEqual([]);
  });

  it("the auth role cannot read tenant tables", async () => {
    const authSql = postgres(testDb.authUrl, { max: 1, onnotice: () => {} });
    try {
      await expect(authSql`select * from conversations`).rejects.toThrow();
    } finally {
      await authSql.end();
    }
  });
});
