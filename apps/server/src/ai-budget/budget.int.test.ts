import { mockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  schema,
  sql,
  type TenantTx,
  tenantTransactions,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Scope } from "../auth/principal.ts";
import { handleDraftReply } from "../drafts/draft-worker.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { setAiBudget } from "../workspaces/ai-budget.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { AiBusyError, aiBudget, type Reservation } from "./budget.ts";
import { seedReservation, seedUsage, usageOn } from "./testing.ts";

// The hard daily AI cap, against real Postgres, with the mock model. Each call costs 120 tokens
// and the budget is 200: the first call fits, the second fits (120 < 200 before it), the third
// is refused before it reaches the model.

const budget = 200;
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
let clock = new Date("2026-11-07T10:00:00Z");
const now = () => clock;

let testDb: TestDatabase;
let db: Database;
/** As the jobs role, to see what waits in the queue. */
let jobsDb: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;
let other: string;

async function receive(n: number, to = "support@acme.test") {
  const raw = [
    "From: jane@customer.test",
    `To: ${to}`,
    `Subject: Question ${n}`,
    `Message-ID: <budget-${n}-${to}>`,
    "Content-Type: text/plain",
    "",
    `Question number ${n}?`,
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(result.kind);
  return result;
}

/** Runs the draft job for one message, as the worker would. */
async function draft(tenantId: string, messageId: string, model = mockModel(callCost)) {
  await handleDraftReply({
    model,
    logger,
    clock: { now },
    config: { ...defaultConfig, dailyTokenBudget: budget },
  })({ tenantId, messageId }, tenantTransactions(db, tenantId));
  return model;
}
const callCost = { text: "Thanks, we're on it.", usage: { inputTokens: 100, outputTokens: 20 } };

const conversation = (tenantId: string, id: string) =>
  db
    .withTenant(tenantId, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.id, id)),
    )
    .then((rows) => rows[0]);
const draftCount = (tenantId: string, conversationId: string) =>
  db
    .withTenant(tenantId, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, conversationId)),
    )
    .then((rows) => rows.length);

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  jobsDb = createDatabase(testDb.jobsUrl);
  auth = createAuthStore(testDb.authUrl);
  // Ingest queues draft jobs; nothing works the queue here, the test runs the handler itself.
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await ensureJobQueues(runner, defaultConfig);
  const a = await initWorkspace(
    { db, auth },
    { workspace: "Acme", mailbox: "support@acme.test", owner: "owner@acme.test" },
  );
  const o = await initWorkspace(
    { db, auth },
    { workspace: "Other", mailbox: "help@other.test", owner: "owner@other.test" },
  );
  if (!a.ok || !o.ok) throw new Error("setup failed");
  acme = a.tenantId;
  other = o.tenantId;
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await jobsDb?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("daily AI budget", () => {
  it("records usage per workspace, then stops before the model once the budget is reached", async () => {
    const first = await receive(1);
    const second = await receive(2);
    await draft(acme, first.messageId);
    await draft(acme, second.messageId);
    expect(await draftCount(acme, second.conversationId)).toBe(1);

    const third = await receive(3);
    const model = await draft(acme, third.messageId);
    // The call after the budget is reached never reaches the model.
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await draftCount(acme, third.conversationId)).toBe(0);
    expect((await conversation(acme, third.conversationId))?.aiPausedReason).toBe("daily_budget");

    const audit = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, third.conversationId)),
    );
    expect(audit.map((e) => [e.action, e.actorType, e.targetType])).toEqual([
      ["ai.paused", "system", "conversation"],
    ]);
  });

  it("is per workspace: another workspace still drafts", async () => {
    const email = await receive(4, "help@other.test");
    const model = await draft(other, email.messageId);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(await draftCount(other, email.conversationId)).toBe(1);
  });

  it("is visible through the API", async () => {
    const app = createApp(
      composeServices({
        db,
        files,
        logger,
        clock: { now },
        config: {
          dailyTokenBudget: budget,
        },
      }),
      {
        authenticate: async () => ({
          tenantId: acme,
          actor: { type: "agent", id: "t" },
          scopes: new Set(["conversations:read"] as const),
        }),
      },
    );
    const res = await app.request("/v1/ai-usage");
    expect(res.status).toBe(200);
    // Acme's two drafts from the first test: 2 x (100 in + 20 out).
    expect(await res.json()).toMatchObject({
      day: "2026-11-07",
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      calls: 2,
      dailyTokenBudget: budget,
      remainingTokens: 0,
      paused: true,
    });
    const refused = await createApp(
      composeServices({
        db,
        files,
        logger,
      }),
    ).request("/v1/ai-usage");
    expect(refused.status).toBe(401);
  });

  it("two jobs at once can't both slip under the budget", async () => {
    clock = new Date("2026-11-09T09:00:00Z");
    await seedUsage(db, acme, "2026-11-09", 100);
    // 100 used, 200 budget, 120 per call: exactly one more call fits.
    const [a, b] = await Promise.all([receive(7), receive(8)]);
    const released = Promise.withResolvers<void>();
    const ma = mockModel({
      ...callCost,
      pause: async () => {
        await released.promise;
      },
    });
    const mb = mockModel(callCost);
    const first = Promise.allSettled([draft(acme, a.messageId, ma)]);
    try {
      // Keep the reservation live until the second job has checked the budget. An instant
      // mock can settle first, making the second job pause successfully instead of retrying.
      await expect.poll(() => ma.doGenerateCalls.length).toBe(1);
      await expect(draft(acme, b.messageId, mb)).rejects.toThrow(AiBusyError);
      expect(await usageOn(db, acme, clock)).toMatchObject({ totalTokens: 100, calls: 0 });
    } finally {
      released.resolve();
      expect((await first).map((r) => r.status)).toEqual(["fulfilled"]);
    }
    expect(ma.doGenerateCalls.length + mb.doGenerateCalls.length).toBe(1);
    expect(await usageOn(db, acme, clock)).toMatchObject({
      totalTokens: 220,
      reservedTokens: 0,
      calls: 1,
    });
    // Its retry finds the budget spent (100 + 120), and pauses the conversation without a call.
    const retry = await draft(acme, b.messageId);
    expect(retry.doGenerateCalls).toHaveLength(0);
    expect((await conversation(acme, b.conversationId))?.aiPausedReason).toBe("daily_budget");
  });

  it("regenerate is refused up front when the budget is spent, and keeps the current draft", async () => {
    clock = new Date("2026-11-10T09:00:00Z");
    const email = await receive(9);
    await draft(acme, email.messageId);
    await seedUsage(db, acme, "2026-11-10", 500);
    const app = createApp(
      composeServices({
        db,
        files,
        logger,
        clock: { now },
        config: {
          dailyTokenBudget: budget,
        },
      }),
      {
        authenticate: async () => ({
          tenantId: acme,
          actor: { type: "agent", id: "t" },
          scopes: new Set(["conversations:read", "drafts:write"] as const),
        }),
      },
    );
    const res = await app.request(`/v1/conversations/${email.conversationId}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenerate: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "daily_budget_reached" });
    const drafts = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, email.conversationId)),
    );
    expect(drafts.map((d) => d.status)).toEqual(["pending"]);
  });

  it("a hand-written draft clears the pause", async () => {
    const email = await receive(10);
    await draft(acme, email.messageId); // still 2026-11-10, over budget: paused
    expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBe("daily_budget");
    const app = createApp(
      composeServices({
        db,
        files,
        logger,
        clock: { now },
        config: {
          dailyTokenBudget: budget,
        },
      }),
      {
        authenticate: async () => ({
          tenantId: acme,
          actor: { type: "agent", id: "t" },
          scopes: new Set(["conversations:read", "drafts:write"] as const),
        }),
      },
    );
    const res = await app.request(`/v1/conversations/${email.conversationId}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hi Jane, answering by hand." }),
    });
    expect(res.status).toBe(201);
    expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBeNull();
  });

  it("resets at UTC midnight, and a new draft clears the pause", async () => {
    clock = new Date("2026-11-08T00:00:01Z");
    const email = await receive(5);
    const paused = await receive(6);
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.conversations)
        .set({ aiPausedReason: "daily_budget" })
        .where(eq(schema.conversations.id, paused.conversationId)),
    );
    const model = await draft(acme, email.messageId);
    expect(model.doGenerateCalls).toHaveLength(1);
    await draft(acme, paused.messageId);
    expect((await conversation(acme, paused.conversationId))?.aiPausedReason).toBeNull();
  });
});

describe("a conversation paused by the budget", () => {
  const waitingJobs = (messageId: string) =>
    jobsDb.withTenant(acme, (tx) =>
      tx.execute<{ data: { tenantId: string; messageId: string }; start: string }>(
        sql`select data, start_after::text as start from pgboss.job
            where name = 'draft-reply' and singleton_key like ${`%${messageId}:after:%`}`,
      ),
    );

  it("is drafted again by itself once the UTC day rolls over", async () => {
    clock = new Date("2026-11-20T15:00:00Z");
    await seedUsage(db, acme, "2026-11-20", budget);
    const email = await receive(30);
    await draft(acme, email.messageId);
    expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBe("daily_budget");

    // Its job waits in the queue until just after midnight UTC.
    const waiting = await waitingJobs(email.messageId);
    expect(waiting.map((j) => new Date(j.start).toISOString())).toEqual([
      "2026-11-21T00:01:00.000Z",
    ]);
    // Paused again the same day (a retry), it still has the one waiting job.
    await draft(acme, email.messageId);
    expect(await waitingJobs(email.messageId)).toHaveLength(1);

    // When that job runs, the budget has reset: the conversation gets its draft.
    clock = new Date("2026-11-21T00:01:00Z");
    const [job] = waiting;
    if (!job) throw new Error("no waiting job");
    await draft(job.data.tenantId, job.data.messageId);
    expect(await draftCount(acme, email.conversationId)).toBe(1);
    expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBeNull();
  });

  it("closed while it waits, it gets no draft, no notice and costs nothing", async () => {
    clock = new Date("2026-11-22T15:00:00Z");
    await seedUsage(db, acme, "2026-11-22", budget);
    const email = await receive(31);
    await draft(acme, email.messageId);
    expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBe("daily_budget");
    const [job] = await waitingJobs(email.messageId);
    if (!job) throw new Error("no waiting job");

    // Someone closes it in the dashboard before the budget resets.
    const app = createApp(composeServices({ db, files, logger, clock: { now } }), {
      authenticate: async () => ({
        tenantId: acme,
        actor: { type: "agent", id: "t" },
        scopes: new Set(["conversations:read", "conversations:write", "drafts:write"] as const),
      }),
    });
    const closed = await app.request(`/v1/conversations/${email.conversationId}/close`, {
      method: "POST",
    });
    expect(closed.status).toBe(200);
    // The next day its waiting job runs: no model call, no reservation, no draft.
    clock = new Date("2026-11-23T00:01:00Z");
    const notices = () =>
      jobsDb.withTenant(acme, (tx) =>
        tx.execute(sql`select 1 from pgboss.job where name = 'draft-notice'`),
      );
    const noticesBefore = (await notices()).length;
    const model = await draft(job.data.tenantId, job.data.messageId);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await draftCount(acme, email.conversationId)).toBe(0);
    expect(await notices()).toHaveLength(noticesBefore);
    expect(await usageOn(db, acme, clock)).toMatchObject({
      totalTokens: 0,
      reservedTokens: 0,
      calls: 0,
    });
  });
});

describe("reserve and spend", () => {
  // On the Other workspace, on days nothing else uses.
  const budgetAt = (now: Date) =>
    aiBudget({ clock: { now: () => now }, config: { dailyTokenBudget: budget }, logger });

  it("a refusal crossing midnight resets after the checked day", async () => {
    await seedUsage(db, other, "2027-01-01", 200);
    let reads = 0;
    const budget = aiBudget({
      clock: {
        now: () => new Date(reads++ === 0 ? "2027-01-01T23:59:59Z" : "2027-01-02T00:00:01Z"),
      },
      config: { dailyTokenBudget: 200 },
      logger,
    });
    const result = await db.withTenant(other, (tx) => budget.reserve(tx, other, 50));
    expect(result).toEqual({ refused: "over_budget", resetsAt: new Date("2027-01-02T00:00:00Z") });
  });

  it("two reservations at the cap at once: the second waits for the first, then is refused", async () => {
    const day = new Date("2026-11-25T12:00:00Z");
    await seedUsage(db, other, "2026-11-25", 100);
    const reserve = (tx: TenantTx) => budgetAt(day).reserve(tx, other, 150);

    let release = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    let markReserved = () => {};
    const reserved = new Promise<void>((done) => {
      markReserved = done;
    });
    // The first keeps its transaction open after reserving, so its row lock is held.
    const first = db.withTenant(other, async (tx) => {
      const r = await reserve(tx);
      markReserved();
      await released;
      return r;
    });
    await reserved;
    const second = db.withTenant(other, reserve);
    // Once the second is seen waiting on that lock, the first commits.
    await expect
      .poll(
        async () =>
          (
            await db.withTenant(other, (tx) =>
              tx.execute(
                sql`select 1 from pg_stat_activity
                    where wait_event_type = 'Lock' and datname = current_database()`,
              ),
            )
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ tenantId: other, day: "2026-11-25", tokens: 150 });
    // 100 spent is under 200, but the first's 150 holds the rest.
    expect(b).toBe("busy");
    expect(await usageOn(db, other, day)).toMatchObject({ totalTokens: 100, reservedTokens: 150 });

    // Settled to what it cost, it lets the rest go.
    await budgetAt(day).spend(tenantTransactions(db, other), a as Reservation, async () => 1, {
      of: () => ({ inputTokens: 50, outputTokens: 10 }),
      ofFailure: () => "unknown",
    });
    expect(await usageOn(db, other, day)).toMatchObject({
      totalTokens: 160,
      reservedTokens: 0,
      calls: 1,
    });
    // Spent to the budget, a reservation is refused until midnight.
    await seedUsage(db, other, "2026-11-25", 40);
    expect(await db.withTenant(other, reserve)).toMatchObject({
      refused: "over_budget",
      resetsAt: new Date("2026-11-26T00:00:00Z"),
    });
  });

  it("a failed call lets its reservation go, or counts all of it when its cost is unknown", async () => {
    const at = new Date("2026-11-26T12:00:00Z");
    const failWith = async (cost: "none" | "unknown") => {
      const r = await db.withTenant(other, (tx) => budgetAt(at).reserve(tx, other, 70));
      if (typeof r === "string" || "refused" in r) throw new Error("reservation refused");
      const spending = budgetAt(at).spend(
        tenantTransactions(db, other),
        r,
        async () => {
          throw new Error("503 service unavailable");
        },
        { of: () => ({ inputTokens: 1, outputTokens: 1 }), ofFailure: () => cost },
      );
      // The call's own error reaches the caller.
      await expect(spending).rejects.toThrow("503 service unavailable");
      return usageOn(db, other, at);
    };
    expect(await failWith("none")).toMatchObject({ totalTokens: 0, reservedTokens: 0, calls: 0 });
    expect(await failWith("unknown")).toMatchObject({
      totalTokens: 70,
      reservedTokens: 0,
      calls: 1,
    });
  });

  it("a reservation that was never settled stops holding the budget once it runs out", async () => {
    const at = new Date("2026-11-29T12:00:00Z");
    await seedUsage(db, other, "2026-11-29", 60);
    const reserve = () => db.withTenant(other, (tx) => budgetAt(at).reserve(tx, other, 100));
    // A call whose process died holds the rest of the budget (60 + 150 of 200): until its
    // reservation runs out, it blocks.
    await seedReservation(db, other, "2026-11-29", 150, 60);
    expect(await reserve()).toBe("busy");
    // Expiry charges the unknown bill, so it is over_budget rather than permanently busy.
    await seedReservation(db, other, "2026-11-29", 150, -1);
    expect(await reserve()).toMatchObject({ refused: "over_budget" });
    expect(await usageOn(db, other, at)).toMatchObject({ totalTokens: 210, reservedTokens: 0 });
    // Repeated attempts cannot forget that bill or charge it twice.
    expect(await reserve()).toMatchObject({ refused: "over_budget" });
    expect(await usageOn(db, other, at)).toMatchObject({ totalTokens: 210, reservedTokens: 0 });
  });

  it("a late settlement cannot release a newer call's reservation", async () => {
    const at = new Date("2026-11-30T12:00:00Z");
    await seedUsage(db, other, "2026-11-30", 10);
    const r = await db.withTenant(other, (tx) => budgetAt(at).reserve(tx, other, 100));
    if (typeof r === "string" || "refused" in r) throw new Error("reservation refused");
    const late = { ...r, tokens: 150, expiresAt: new Date("2000-01-01T00:00:00Z") };
    await budgetAt(at).spend(tenantTransactions(db, other), late, async () => 1, {
      of: () => ({ inputTokens: 10, outputTokens: 0 }),
      ofFailure: () => "unknown",
    });
    expect(await usageOn(db, other, at)).toMatchObject({ totalTokens: 10, reservedTokens: 100 });
    await budgetAt(at).spend(tenantTransactions(db, other), r, async () => 1, {
      of: () => ({ inputTokens: 30, outputTokens: 0 }),
      ofFailure: () => "unknown",
    });
    expect(await usageOn(db, other, at)).toMatchObject({ totalTokens: 40, reservedTokens: 0 });
  });

  it("settles on the day it was reserved, even after midnight", async () => {
    const before = new Date("2026-11-27T23:59:59Z");
    const after = new Date("2026-11-28T00:00:01Z");
    const r = await db.withTenant(other, (tx) => budgetAt(before).reserve(tx, other, 30));
    if (typeof r === "string" || "refused" in r) throw new Error("reservation refused");
    await budgetAt(after).spend(tenantTransactions(db, other), r, async () => 1, {
      of: () => ({ inputTokens: 20, outputTokens: 0 }),
      ofFailure: () => "unknown",
    });
    expect(await usageOn(db, other, before)).toMatchObject({ totalTokens: 20, reservedTokens: 0 });
    expect(await usageOn(db, other, after)).toMatchObject({ totalTokens: 0 });
  });
});

describe("per-workspace AI budget", () => {
  // The env value (`budget`, 200) is the server-wide ceiling; these run on the Other workspace.
  const usageFor = (tenantId: string, scopes: Scope[]) =>
    createApp(
      composeServices({
        db,
        files,
        logger,
        clock: { now },
        config: {
          dailyTokenBudget: budget,
        },
      }),
      {
        authenticate: async () => ({
          tenantId,
          actor: { type: "agent", id: "t" },
          scopes: new Set(scopes),
        }),
      },
    );

  it("a workspace budget below the ceiling is enforced", async () => {
    clock = new Date("2026-12-01T09:00:00Z");
    expect(await setAiBudget(db, { tenantId: other, budget: 100 })).toEqual({ ok: true });
    const [a, b] = [await receive(20, "help@other.test"), await receive(21, "help@other.test")];
    expect((await draft(other, a.messageId)).doGenerateCalls).toHaveLength(1);
    // 120 used: under the ceiling, but over the workspace's own 100.
    expect((await draft(other, b.messageId)).doGenerateCalls).toHaveLength(0);
    expect((await conversation(other, b.conversationId))?.aiPausedReason).toBe("daily_budget");

    const res = await usageFor(other, ["conversations:read"]).request("/v1/ai-usage");
    expect(await res.json()).toMatchObject({ dailyTokenBudget: 100, paused: true });
  });

  it("above the ceiling, the ceiling wins", async () => {
    clock = new Date("2026-12-02T09:00:00Z");
    await setAiBudget(db, { tenantId: other, budget: 1_000_000 });
    const emails = [];
    for (const n of [22, 23, 24]) emails.push(await receive(n, "help@other.test"));
    const calls = [];
    for (const e of emails) calls.push((await draft(other, e.messageId)).doGenerateCalls.length);
    // 0 and 120 are under 200; at 240 the ceiling stops the third.
    expect(calls).toEqual([1, 1, 0]);

    const res = await usageFor(other, ["conversations:read"]).request("/v1/ai-usage");
    expect(await res.json()).toMatchObject({ dailyTokenBudget: budget, remainingTokens: 0 });
  });

  it("a workspace token can't change its own budget", async () => {
    await setAiBudget(db, { tenantId: other, budget: 50 });
    const app = usageFor(other, ["conversations:read", "workspace:admin", "drafts:write"]);
    // The only workspace settings route rejects fields it doesn't know.
    const res = await app.request("/v1/workspace/shadow-mode", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: "x@other.test", aiDailyTokenBudget: 1_000_000 }),
    });
    expect(res.status).toBe(400);
    // And no API operation accepts a budget at all.
    const doc = await (await app.request("/openapi.json")).text();
    expect(doc).not.toMatch(/aiDailyTokenBudget|ai_daily_token_budget/);
    const [row] = await db.withTenant(other, (tx) =>
      tx.select().from(schema.tenants).where(eq(schema.tenants.id, other)),
    );
    expect(row?.aiDailyTokenBudget).toBe(50);
  });

  it("every change is audit-logged, and null falls back to the ceiling", async () => {
    clock = new Date("2026-12-03T09:00:00Z");
    const budgetEvents = () =>
      db.withTenant(other, (tx) =>
        tx
          .select()
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.action, "workspace.ai_budget_changed")),
      );
    const before = (await budgetEvents()).length;
    await setAiBudget(db, { tenantId: other, budget: null });
    const events = await budgetEvents();
    expect(events).toHaveLength(before + 1);
    expect(events.map((e) => [e.actorType, e.actorId, e.targetType, e.targetId])).toContainEqual([
      "system",
      "operator-cli",
      "workspace",
      other,
    ]);
    const res = await usageFor(other, ["conversations:read"]).request("/v1/ai-usage");
    expect(await res.json()).toMatchObject({ dailyTokenBudget: budget });
  });

  it("refuses an unknown workspace and a negative budget", async () => {
    expect(
      await setAiBudget(db, { tenantId: "00000000-0000-7000-8000-000000000000", budget: 10 }),
    ).toEqual({ ok: false, reason: "workspace_not_found" });
    await expect(setAiBudget(db, { tenantId: other, budget: -1 })).rejects.toThrow();
  });
});
