import {
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  schema,
  sql,
  uuidv7,
} from "@helpos/db";
import { type Actor, builtInActors } from "@helpos/db/actor";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { aiBudget, utcDay } from "../ai-budget/budget.ts";
import { seedReservation, seedUsage } from "../ai-budget/testing.ts";
import type { AuditContext } from "../audit/audit.ts";
import {
  addMessage,
  closeConversation,
  createConversation,
  pauseAi,
} from "../conversations/lifecycle.ts";
import { ensureJobQueues } from "../jobs.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import {
  approveDraft,
  createReply,
  lockConversationForDrafting,
  markSendFailed,
  markSending,
  markSent,
  regenerateDraft,
} from "./lifecycle.ts";

let testDb: TestDatabase;
let db: Database;
let jobsDb: Database;
let runner: JobRunner;
let tenantId: string;
let otherTenantId: string;
let mailboxId: string;
let customerId: string;
const onError = vi.fn();
const now = new Date("2026-11-12T12:00:00Z");
const budget = aiBudget({
  clock: { now: () => now },
  config: { dailyTokenBudget: 1000 },
  logger: { warn: vi.fn() },
});
const context = (actor: Actor = builtInActors.draftWorker): AuditContext => ({
  tenantId,
  actor,
  requestId: uuidv7(),
});

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  jobsDb = createDatabase(testDb.jobsUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError });
  await runner.start();
  await ensureJobQueues(runner, { jobRetry: undefined });
  const auth = createAuthStore(testDb.authUrl);
  try {
    for (const slug of ["regenerate", "other"]) {
      const workspace = await initWorkspace(
        { db, auth },
        { workspace: slug, mailbox: `${slug}@operation.test`, owner: `${slug}@owner.test` },
      );
      if (!workspace.ok) throw new Error("workspace setup failed");
      if (slug === "regenerate") tenantId = workspace.tenantId;
      else otherTenantId = workspace.tenantId;
    }
    await db.withTenant(tenantId, async (tx) => {
      const [mailbox] = await tx.select().from(schema.mailboxes);
      if (!mailbox) throw new Error("mailbox missing");
      mailboxId = mailbox.id;
      customerId = uuidv7();
      await tx
        .insert(schema.customers)
        .values({ tenantId, id: customerId, email: "customer@test.test" });
    });
  } finally {
    await auth.close();
  }
});

afterAll(async () => {
  await runner?.stop();
  await jobsDb?.close();
  await db?.close();
  await testDb?.stop();
  expect(onError).not.toHaveBeenCalled();
});

async function conversation(automated = false) {
  const conversationId = uuidv7();
  const messageId = uuidv7();
  await db.withTenant(tenantId, async (tx) => {
    await createConversation(tx, {
      id: conversationId,
      tenantId,
      mailboxId,
      customerId,
      subject: "Question",
    });
    await addMessage(tx, {
      id: messageId,
      tenantId,
      conversationId,
      direction: "inbound",
      fromAddress: "customer@test.test",
      toAddresses: ["regenerate@operation.test"],
      subject: "Question",
      references: [],
      rawFileKey: "test/raw",
      automatedReason: automated ? "auto_submitted" : null,
    });
  });
  return { tenantId, conversationId, messageId, body: "Old reply", noticeDelaySeconds: 3600 };
}

const draftsOf = (id: string) =>
  db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, id)),
  );
const conversationOf = (id: string) =>
  db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.conversations).where(eq(schema.conversations.id, id)),
  );
const jobsFor = (messageId: string) =>
  jobsDb.withTenant(tenantId, (tx) =>
    tx.execute<{ data: { tenantId: string; messageId: string }; singleton_key: string }>(sql`
    select data, singleton_key from pgboss.job
    where name = 'draft-reply' and data->>'messageId' = ${messageId}
  `),
  );

it.each([
  { type: "user", id: "person" },
  { type: "agent", id: "token" },
  builtInActors.draftWorker,
] satisfies Actor[])(
  "regenerates directly for $type with atomic discard attribution and one job",
  async (actor) => {
    const input = await conversation();
    const audit = context(actor);
    const stale = await db.withTenant(tenantId, async (tx) => {
      const reply = await createReply(tx, context(), input);
      await pauseAi(tx, context(), input.conversationId, "draft_failed");
      return reply;
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        db.withTenant(tenantId, (tx) => regenerateDraft(tx, audit, input.conversationId, budget)),
      ),
    );
    expect(results).toContainEqual({ outcome: "queued", discardedDraftIds: [stale.id] });
    expect(results).toContainEqual({ outcome: "queued", discardedDraftIds: [] });
    expect((await draftsOf(input.conversationId)).map(({ status }) => status)).toEqual([
      "discarded",
    ]);
    expect(await conversationOf(input.conversationId)).toMatchObject([{ aiPausedReason: null }]);
    expect(await jobsFor(input.messageId)).toEqual([
      {
        data: { tenantId, messageId: input.messageId },
        singleton_key: `${tenantId}:${input.messageId}`,
      },
    ]);
    const events = await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.requestId, audit.requestId ?? "")),
    );
    expect(events).toMatchObject([
      {
        action: "draft.discarded",
        targetId: stale.id,
        targetType: "draft",
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        requestId: audit.requestId,
        details: { reason: "manual", operation: "regenerate" },
      },
    ]);
  },
);

it("keeps a daily-budget marker while queuing a fresh try", async () => {
  const input = await conversation();
  await db.withTenant(tenantId, async (tx) => {
    await pauseAi(tx, context(), input.conversationId, "daily_budget");
    expect(await regenerateDraft(tx, context(), input.conversationId, budget)).toEqual({
      outcome: "queued",
      discardedDraftIds: [],
    });
  });
  expect(await conversationOf(input.conversationId)).toMatchObject([
    { aiPausedReason: "daily_budget" },
  ]);
});

it("returns not_found for both absent and other-tenant conversations", async () => {
  const input = await conversation();
  for (const id of [input.conversationId, uuidv7()]) {
    expect(
      await db.withTenant(otherTenantId, (tx) =>
        regenerateDraft(tx, { ...context(), tenantId: otherTenantId }, id, budget),
      ),
    ).toEqual({ outcome: "not_found" });
  }
  expect(await jobsFor(input.messageId)).toEqual([]);
});

it("refuses machine mail before considering the closed state or budget", async () => {
  const input = await conversation(true);
  await db.withTenant(tenantId, async (tx) => {
    await closeConversation(tx, context(), input.conversationId);
    expect(await regenerateDraft(tx, context(), input.conversationId, budget)).toEqual({
      outcome: "nothing_to_answer",
    });
  });
  expect(await jobsFor(input.messageId)).toEqual([]);
});

it.each(["approved", "send_uncertain", "send_failed", "sent"] as const)(
  "leaves a %s reply untouched and refuses before the closed state",
  async (status) => {
    const input = await conversation();
    const draft = await db.withTenant(tenantId, async (tx) => {
      const audit = context();
      const draft = await createReply(tx, audit, input);
      await approveDraft(tx, audit, draft.id, draft.body);
      if (status === "send_failed") await markSendFailed(tx, audit, draft.id);
      if (status === "send_uncertain" || status === "sent") {
        await markSending(tx, audit, draft.id, input.messageId);
      }
      if (status === "sent")
        await markSent(tx, audit, draft.id, { sentAt: now, sentMessageId: input.messageId });
      await closeConversation(tx, audit, input.conversationId);
      return draft;
    });
    const before = await draftsOf(input.conversationId);
    expect(
      await db.withTenant(tenantId, (tx) =>
        regenerateDraft(tx, context(), input.conversationId, budget),
      ),
    ).toEqual({ outcome: "already_answered" });
    expect(await draftsOf(input.conversationId)).toEqual(before);
    expect(before).toMatchObject([{ id: draft.id, status }]);
    expect(await jobsFor(input.messageId)).toEqual([]);
  },
);

it("keeps the stale draft and failed marker on closed and exhausted-budget refusals", async () => {
  const input = await conversation();
  await db.withTenant(tenantId, async (tx) => {
    await createReply(tx, context(), input);
    await pauseAi(tx, context(), input.conversationId, "draft_failed");
  });
  const before = await draftsOf(input.conversationId);
  const exhausted = aiBudget({
    clock: { now: () => now },
    config: { dailyTokenBudget: 0 },
    logger: { warn: vi.fn() },
  });
  expect(
    await db.withTenant(tenantId, (tx) =>
      regenerateDraft(tx, context(), input.conversationId, exhausted),
    ),
  ).toEqual({ outcome: "daily_budget_reached" });
  await db.withTenant(tenantId, (tx) => closeConversation(tx, context(), input.conversationId));
  expect(
    await db.withTenant(tenantId, (tx) =>
      regenerateDraft(tx, context(), input.conversationId, exhausted),
    ),
  ).toEqual({ outcome: "conversation_closed" });
  expect(await draftsOf(input.conversationId)).toEqual(before);
  expect(await conversationOf(input.conversationId)).toMatchObject([
    { aiPausedReason: "draft_failed" },
  ]);
  expect(await jobsFor(input.messageId)).toEqual([]);
});

it("rolls back discard, audit, failed-marker clearing and enqueue with the caller transaction", async () => {
  const input = await conversation();
  await db.withTenant(tenantId, async (tx) => {
    await createReply(tx, context(), input);
    await pauseAi(tx, context(), input.conversationId, "draft_failed");
  });
  const before = await draftsOf(input.conversationId);
  const audit = context();
  await expect(
    db.withTenant(tenantId, async (tx) => {
      expect((await regenerateDraft(tx, audit, input.conversationId, budget)).outcome).toBe(
        "queued",
      );
      throw new Error("caller rollback");
    }),
  ).rejects.toThrow("caller rollback");
  expect(await draftsOf(input.conversationId)).toEqual(before);
  expect(await conversationOf(input.conversationId)).toMatchObject([
    { aiPausedReason: "draft_failed" },
  ]);
  expect(await jobsFor(input.messageId)).toEqual([]);
  expect(
    await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.requestId, audit.requestId ?? "")),
    ),
  ).toEqual([]);
});

it("answers the latest human message and discards replies to older messages", async () => {
  const input = await conversation();
  const latest = uuidv7();
  const old = await db.withTenant(tenantId, async (tx) => {
    const old = await createReply(tx, context(), input);
    for (const [id, direction, automatedReason, createdAt] of [
      [latest, "inbound", null, "2030-01-01T00:00:00Z"],
      [uuidv7(), "inbound", "auto_submitted", "2030-01-02T00:00:00Z"],
      [uuidv7(), "outbound", null, "2030-01-03T00:00:00Z"],
    ] as const) {
      await addMessage(tx, {
        id,
        direction,
        automatedReason,
        createdAt: new Date(createdAt),
        tenantId,
        conversationId: input.conversationId,
        fromAddress: "customer@test.test",
        toAddresses: ["regenerate@operation.test"],
        subject: "Later message",
        references: [],
        rawFileKey: "test/raw",
      });
    }
    return old;
  });
  expect(
    await db.withTenant(tenantId, (tx) =>
      regenerateDraft(tx, context(), input.conversationId, budget),
    ),
  ).toEqual({ outcome: "queued", discardedDraftIds: [old.id] });
  expect(await jobsFor(input.messageId)).toEqual([]);
  expect(await jobsFor(latest)).toMatchObject([{ data: { tenantId, messageId: latest } }]);
  expect(await draftsOf(input.conversationId)).toMatchObject([{ id: old.id, status: "discarded" }]);
});

it("waits for the conversation writer lock before queuing", async () => {
  const input = await conversation();
  await db.withTenant(tenantId, async (tx) => {
    await lockConversationForDrafting(tx, input.conversationId);
    await expect(
      db.withTenant(tenantId, async (contender) => {
        await contender.execute(sql`set local lock_timeout = '100ms'`);
        return regenerateDraft(contender, context(), input.conversationId, budget);
      }),
    ).rejects.toMatchObject({ cause: { code: "55P03" } });
    expect(await jobsFor(input.messageId)).toEqual([]);
  });
  expect(
    await db.withTenant(tenantId, (tx) =>
      regenerateDraft(tx, context(), input.conversationId, budget),
    ),
  ).toEqual({ outcome: "queued", discardedDraftIds: [] });
  expect(await jobsFor(input.messageId)).toHaveLength(1);
});

it("reads real spend and in-flight holds using today's existing budget semantics", async () => {
  const budgetDay = new Date("2026-11-13T12:00:00Z");
  const isolatedBudget = aiBudget({
    clock: { now: () => budgetDay },
    config: { dailyTokenBudget: 1000 },
    logger: { warn: vi.fn() },
  });
  const input = await conversation();
  await seedReservation(db, tenantId, utcDay(budgetDay), 1000, 600);
  expect(
    await db.withTenant(tenantId, (tx) =>
      regenerateDraft(tx, context(), input.conversationId, isolatedBudget),
    ),
  ).toEqual({ outcome: "queued", discardedDraftIds: [] });
  await seedUsage(db, tenantId, utcDay(budgetDay), 1000);
  const spent = await conversation();
  expect(
    await db.withTenant(tenantId, (tx) =>
      regenerateDraft(tx, context(), spent.conversationId, isolatedBudget),
    ),
  ).toEqual({ outcome: "daily_budget_reached" });
  expect(await jobsFor(spent.messageId)).toEqual([]);
});
