import {
  asc,
  createAuthStore,
  createDatabase,
  type Database,
  eq,
  schema,
  uuidv7,
} from "@helpos/db";
import { type Actor, builtInActors } from "@helpos/db/actor";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuditContext } from "../audit/audit.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import {
  addMessage,
  clearAiPause,
  closeConversation,
  createConversation,
  markMessageSent,
  pauseAi,
  recordActivity,
  removeRejectedMessage,
  reopenConversation,
} from "./lifecycle.ts";

let testDb: TestDatabase;
let db: Database;
let tenantId: string;
let mailboxId: string;
let customerId: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  const auth = createAuthStore(testDb.authUrl);
  try {
    const workspace = await initWorkspace(
      { db, auth },
      { workspace: "Lifecycle", mailbox: "support@lifecycle.test", owner: "owner@lifecycle.test" },
    );
    if (!workspace.ok) throw new Error("workspace setup failed");
    tenantId = workspace.tenantId;
    await db.withTenant(tenantId, async (tx) => {
      const [mailbox] = await tx.select().from(schema.mailboxes);
      if (!mailbox) throw new Error("mailbox missing");
      mailboxId = mailbox.id;
      customerId = uuidv7();
      await tx
        .insert(schema.customers)
        .values({ id: customerId, tenantId, email: "customer@lifecycle.test" });
    });
  } finally {
    await auth.close();
  }
});

afterAll(async () => {
  await db?.close();
  await testDb?.stop();
});

async function conversation() {
  const id = uuidv7();
  await db.withTenant(tenantId, (tx) =>
    createConversation(tx, {
      id,
      tenantId,
      mailboxId,
      customerId,
      subject: "Lifecycle",
      automated: true,
      lastMessageAt: new Date("2026-01-01T00:00:00Z"),
    }),
  );
  return id;
}

const read = (id: string) =>
  db.withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id));
    return row;
  });

it.each([
  { type: "user", id: "person" },
  { type: "agent", id: "token" },
  builtInActors.draftWorker,
] satisfies Actor[])(
  "preserves close and pause event order and $type attribution without duplicate close events",
  async (actor) => {
    const id = await conversation();
    const context: AuditContext = { tenantId, actor, requestId: `lifecycle-${id}` };
    await db.withTenant(tenantId, async (tx) => {
      expect(await closeConversation(tx, context, id)).toBe(true);
      expect(await closeConversation(tx, context, id)).toBe(false);
      await pauseAi(tx, context, id, "daily_budget");
      await clearAiPause(tx, id, "draft_failed");
    });
    expect(await read(id)).toMatchObject({
      status: "closed",
      automated: true,
      aiPausedReason: "daily_budget",
    });
    await db.withTenant(tenantId, async (tx) => {
      await pauseAi(tx, context, id, "draft_failed");
      await clearAiPause(tx, id, "draft_failed");
      await reopenConversation(tx, id, new Date("2026-01-03T00:00:00Z"));
    });
    expect(await read(id)).toMatchObject({
      status: "open",
      automated: false,
      aiPausedReason: null,
      lastMessageAt: new Date("2026-01-03T00:00:00Z"),
    });
    const events = await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, id))
        .orderBy(asc(schema.auditEvents.id)),
    );
    expect(events.map((event) => event.action)).toEqual([
      "conversation.closed",
      "ai.paused",
      "ai.draft_failed",
    ]);
    for (const event of events)
      expect(event).toMatchObject({
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        requestId: context.requestId,
      });
  },
);

it("rolls back the conversation write when its audit context belongs to another tenant", async () => {
  const id = await conversation();
  const context = { tenantId: uuidv7(), actor: builtInActors.draftWorker, requestId: null };
  await expect(
    db.withTenant(tenantId, (tx) => closeConversation(tx, context, id)),
  ).rejects.toThrow();
  await expect(
    db.withTenant(tenantId, (tx) => pauseAi(tx, context, id, "draft_failed")),
  ).rejects.toThrow();
  expect(await read(id)).toMatchObject({ status: "open", aiPausedReason: null });
});

it("preserves supplied message IDs and timestamps and generates them when omitted", async () => {
  const conversationId = await conversation();
  const id = uuidv7();
  const createdAt = new Date("2026-01-02T00:00:00Z");
  const sentAt = new Date("2025-12-30T00:00:00Z");
  const message = {
    tenantId,
    conversationId,
    direction: "inbound",
    fromAddress: "customer@lifecycle.test",
    toAddresses: ["support@lifecycle.test"],
    subject: "Import",
    references: [],
    rawFileKey: "test/raw",
  } satisfies typeof schema.messages.$inferInsert;
  await db.withTenant(tenantId, async (tx) => {
    await addMessage(tx, {
      ...message,
      id,
      createdAt,
      updatedAt: createdAt,
      sentAt,
    });
    await addMessage(tx, message);
  });
  const rows = await db.withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(asc(schema.messages.createdAt)),
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ id, createdAt, updatedAt: createdAt, sentAt });
  expect(rows[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(rows[1]?.createdAt.getTime()).toBeGreaterThan(createdAt.getTime());
});

it("leaves prepared outbound activity unconfirmed until sent and removes rejected preparations", async () => {
  const conversationId = await conversation();
  const id = uuidv7();
  const before = await read(conversationId);
  await db.withTenant(tenantId, (tx) =>
    addMessage(tx, {
      id,
      tenantId,
      conversationId,
      direction: "outbound",
      fromAddress: "support@lifecycle.test",
      toAddresses: ["customer@lifecycle.test"],
      subject: "Reply",
      references: [],
      rawFileKey: "test/raw",
      sentAt: null,
    }),
  );
  expect(await read(conversationId)).toEqual(before);
  const sentAt = new Date();
  await db.withTenant(tenantId, async (tx) => {
    await markMessageSent(tx, id, sentAt);
    await recordActivity(tx, conversationId, sentAt);
  });
  expect(await read(conversationId)).toMatchObject({ lastMessageAt: sentAt });
  const [sent] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.messages).where(eq(schema.messages.id, id)),
  );
  expect(sent?.sentAt).toEqual(sentAt);
  const rejectedId = uuidv7();
  await db.withTenant(tenantId, async (tx) => {
    if (!sent) throw new Error("confirmed message missing");
    await addMessage(tx, { ...sent, id: rejectedId, sentAt: null });
    await removeRejectedMessage(tx, rejectedId);
  });
  expect(
    await db.withTenant(tenantId, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.id, rejectedId)),
    ),
  ).toEqual([]);
});
