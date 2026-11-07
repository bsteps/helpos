import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthStore, createAuthStore } from "./auth.ts";
import { createDatabase, type Database, type TenantTx } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import {
  aiUsage,
  attachments,
  auditEvents,
  customers,
  drafts,
  mailboxes,
  memberships,
  messages,
  tenants,
  tickets,
} from "./schema.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

// Cross-tenant leak suite, MVP part (ADR 0003 §5, ADR 0009). Tenant B owns data; acting as
// tenant A must never see, change or reference any of it. #8 extends this to every endpoint.

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;

const tenantA = uuidv7();
const tenantB = uuidv7();
const b = {
  mailbox: uuidv7(),
  customer: uuidv7(),
  ticket: uuidv7(),
  message: uuidv7(),
  attachment: uuidv7(),
  membership: uuidv7(),
  draft: uuidv7(),
  auditEvent: uuidv7(),
  userId: "",
};

async function seedB(tx: TenantTx): Promise<void> {
  const tenantId = tenantB;
  await tx.insert(tenants).values({ id: tenantId, name: "b" });
  await tx.insert(mailboxes).values({ id: b.mailbox, tenantId, address: "support@b.test" });
  await tx
    .insert(memberships)
    .values({ id: b.membership, tenantId, userId: b.userId, role: "owner" });
  await tx.insert(customers).values({ id: b.customer, tenantId, email: "jane@customer.test" });
  await tx.insert(tickets).values({
    id: b.ticket,
    tenantId,
    customerId: b.customer,
    mailboxId: b.mailbox,
    subject: "Help",
  });
  await tx.insert(messages).values({
    id: b.message,
    tenantId,
    ticketId: b.ticket,
    direction: "inbound",
    fromAddress: "jane@customer.test",
    toAddresses: ["support@b.test"],
    subject: "Help",
    references: [],
    rawFileKey: `${tenantId}/raw`,
    messageIdHeader: "<b@customer.test>",
  });
  await tx.insert(attachments).values({
    id: b.attachment,
    tenantId,
    messageId: b.message,
    contentType: "text/plain",
    sizeBytes: 1,
    fileKey: `${tenantId}/file`,
  });
  await tx.insert(drafts).values({
    id: b.draft,
    tenantId,
    ticketId: b.ticket,
    messageId: b.message,
    body: "Hi Jane",
  });
  await tx.insert(aiUsage).values({ tenantId, day: "2026-11-07", inputTokens: 10 });
  await tx.insert(auditEvents).values({
    id: b.auditEvent,
    tenantId,
    actorType: "system",
    actorId: "draft-reply",
    action: "draft.created",
    targetType: "draft",
    targetId: b.draft,
  });
}

/** A minimal ticket in tenant A, so A-side tests have something valid to point at. */
async function seedTicketInA(tx: TenantTx, address: string) {
  const ids = { mailbox: uuidv7(), customer: uuidv7(), ticket: uuidv7() };
  await tx.insert(mailboxes).values({ id: ids.mailbox, tenantId: tenantA, address });
  await tx.insert(customers).values({ id: ids.customer, tenantId: tenantA, email: address });
  await tx.insert(tickets).values({
    id: ids.ticket,
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
  b.userId = (await auth.ensureUser("owner@b.test")).id;
  await db.withTenant(tenantB, seedB);
  await db.withTenant(tenantA, (tx) => tx.insert(tenants).values({ id: tenantA, name: "a" }));
});

afterAll(async () => {
  await db?.close();
  await auth?.close();
  await testDb?.container.stop();
});

const tables = {
  mailboxes,
  memberships,
  customers,
  tickets,
  messages,
  attachments,
  drafts,
  aiUsage,
} as const;

describe("leak: acting as tenant A", () => {
  for (const [name, table] of Object.entries(tables)) {
    it(`cannot read B's ${name}`, async () => {
      const rows = await db.withTenant(tenantA, (tx) => tx.select().from(table));
      expect(rows).toEqual([]);
    });

    it(`cannot update or delete B's ${name}`, async () => {
      const changed = await db.withTenant(tenantA, async (tx) => {
        const updated = await tx.update(table).set({ updatedAt: new Date() }).returning();
        const deleted = await tx.delete(table).returning();
        return updated.length + deleted.length;
      });
      expect(changed).toBe(0);
      const stillThere = await db.withTenant(tenantB, (tx) => tx.select().from(table));
      expect(stillThere).toHaveLength(1);
    });
  }

  // Not in `tables`: the app role can't UPDATE or DELETE audit events at all (schema.test.ts).
  it("cannot read B's audit_events", async () => {
    const rows = await db.withTenant(tenantA, (tx) => tx.select().from(auditEvents));
    expect(rows).toEqual([]);
  });

  it("cannot insert a row tagged with B's tenant_id", async () => {
    await expect(
      db.withTenant(tenantA, (tx) =>
        tx.insert(customers).values({ tenantId: tenantB, email: "x@customer.test" }),
      ),
    ).rejects.toThrow();
  });

  it("cannot point a message at B's ticket, even with its ID", async () => {
    await expect(
      db.withTenant(tenantA, async (tx) => {
        await seedTicketInA(tx, "fk@a.test");
        await tx.insert(messages).values({
          tenantId: tenantA,
          ticketId: b.ticket,
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

  it("fetching B's ticket ID finds nothing, same as an unknown ID", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, b.ticket)),
    );
    expect(rows).toEqual([]);
  });

  it("creating a customer with B's email succeeds in A", async () => {
    await db.withTenant(tenantA, (tx) =>
      tx.insert(customers).values({ tenantId: tenantA, email: "jane@customer.test" }),
    );
    const mine = await db.withTenant(tenantA, (tx) =>
      tx.select().from(customers).where(eq(customers.email, "jane@customer.test")),
    );
    expect(mine).toHaveLength(1);
  });

  it("a Message-ID that B already has is accepted in A", async () => {
    // Per-tenant uniqueness: no error tells A that B received this email.
    await db.withTenant(tenantA, async (tx) => {
      const ids = await seedTicketInA(tx, "mid@a.test");
      await tx.insert(messages).values({
        tenantId: tenantA,
        ticketId: ids.ticket,
        direction: "inbound",
        fromAddress: "m@c.test",
        toAddresses: [],
        subject: "x",
        references: [],
        rawFileKey: "k",
        messageIdHeader: "<b@customer.test>",
      });
    });
  });
});

describe("mailbox routing", () => {
  it("resolves an address to its tenant, case-insensitively", async () => {
    expect(await db.resolveMailbox(" Support@B.test ")).toEqual({
      tenantId: tenantB,
      mailboxId: b.mailbox,
    });
  });

  it("returns null for an unknown address", async () => {
    expect(await db.resolveMailbox("nobody@nowhere.test")).toBeNull();
  });

  it("shows only the asked-for mailbox, never the others", async () => {
    const rows = await db.withTenant(uuidv7(), async (tx) => {
      await tx.execute(sql`select set_config('app.mailbox_address', 'support@b.test', true)`);
      return tx.select().from(mailboxes);
    });
    expect(rows.map((r) => r.address)).toEqual(["support@b.test"]);
  });

  it("reports a taken address as a unique violation, without saying who owns it", async () => {
    const error = await db
      .withTenant(tenantA, (tx) =>
        tx.insert(mailboxes).values({ tenantId: tenantA, address: "support@b.test" }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isUniqueViolation(error, "mailboxes_address")).toBe(true);
  });
});

describe("auth tables (ADR 0009 §1)", () => {
  it("leak: auth tables are not readable by the app role", async () => {
    await expect(
      db.withTenant(tenantA, (tx) => tx.execute(sql`select * from auth.users`)),
    ).rejects.toThrow();
  });

  it("leak: memberships lists only my own rows across tenants", async () => {
    const other = await auth.ensureUser("someone@a.test");
    await db.withTenant(tenantA, (tx) =>
      tx.insert(memberships).values({ tenantId: tenantA, userId: other.id, role: "member" }),
    );
    expect(await db.listMemberships(b.userId)).toEqual([{ tenantId: tenantB, role: "owner" }]);
    expect(await db.listMemberships(other.id)).toEqual([{ tenantId: tenantA, role: "member" }]);
  });

  it("leak: a user of B has no membership when acting as A", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, b.userId)),
    );
    expect(rows).toEqual([]);
  });

  it("ensureUser is idempotent and normalises case", async () => {
    expect((await auth.ensureUser("Owner@B.test")).id).toBe(b.userId);
  });

  it("emailsOf returns only the emails of the IDs given", async () => {
    expect(await auth.emailsOf([b.userId])).toEqual(["owner@b.test"]);
    expect(await auth.emailsOf([])).toEqual([]);
  });

  it("the auth role cannot read tenant tables", async () => {
    const authSql = postgres(testDb.authUrl, { max: 1, onnotice: () => {} });
    try {
      await expect(authSql`select * from tickets`).rejects.toThrow();
    } finally {
      await authSql.end();
    }
  });
});
