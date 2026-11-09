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
  tenantTransactions,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Scope } from "../auth/principal.ts";
import { handleDraftReply } from "../drafts/draft-worker.ts";
import { draftNoticeJob, draftReplyJob } from "../drafts/jobs.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { setAiBudget } from "../workspaces/ai-budget.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { recordUsage } from "./budget.ts";

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
  await handleDraftReply({ model, logger, dailyTokenBudget: budget, now })(
    { tenantId, messageId },
    tenantTransactions(db, tenantId),
  );
  return model;
}
const callCost = { text: "Thanks, we're on it.", usage: { inputTokens: 100, outputTokens: 20 } };

const ticket = (tenantId: string, id: string) =>
  db
    .withTenant(tenantId, (tx) => tx.select().from(schema.tickets).where(eq(schema.tickets.id, id)))
    .then((rows) => rows[0]);
const draftCount = (tenantId: string, ticketId: string) =>
  db
    .withTenant(tenantId, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, ticketId)),
    )
    .then((rows) => rows.length);

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  // Ingest queues draft jobs; nothing works the queue here, the test runs the handler itself.
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await runner.ensureQueue(draftReplyJob);
  await runner.ensureQueue(draftNoticeJob);
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
  await auth?.close();
  await testDb?.stop();
});

describe("daily AI budget", () => {
  it("records usage per workspace, then stops before the model once the budget is reached", async () => {
    const first = await receive(1);
    const second = await receive(2);
    await draft(acme, first.messageId);
    await draft(acme, second.messageId);
    expect(await draftCount(acme, second.ticketId)).toBe(1);

    const third = await receive(3);
    const model = await draft(acme, third.messageId);
    // The call after the budget is reached never reaches the model.
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(await draftCount(acme, third.ticketId)).toBe(0);
    expect((await ticket(acme, third.ticketId))?.aiPausedReason).toBe("daily_budget");

    const audit = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, third.ticketId)),
    );
    expect(audit.map((e) => [e.action, e.actorType, e.targetType])).toEqual([
      ["ai.paused", "system", "ticket"],
    ]);
  });

  it("is per workspace: another workspace still drafts", async () => {
    const email = await receive(4, "help@other.test");
    const model = await draft(other, email.messageId);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(await draftCount(other, email.ticketId)).toBe(1);
  });

  it("is visible through the API", async () => {
    const app = createApp({
      db,
      files,
      logger,
      inboundSecret: undefined,
      dailyTokenBudget: budget,
      now,
      authenticate: async () => ({
        tenantId: acme,
        actor: { type: "agent", id: "t" },
        scopes: new Set(["tickets:read"] as const),
      }),
    });
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
    const refused = await createApp({ db, files, logger, inboundSecret: undefined }).request(
      "/v1/ai-usage",
    );
    expect(refused.status).toBe(401);
  });

  it("two jobs at once can't both slip under the budget", async () => {
    clock = new Date("2026-11-09T09:00:00Z");
    await db.withTenant(acme, (tx) =>
      recordUsage(tx, acme, "2026-11-09", { inputTokens: 100, outputTokens: 0 }),
    );
    // 100 used, 200 budget, 120 per call: exactly one more call fits.
    const [a, b] = await Promise.all([receive(7), receive(8)]);
    const [ma, mb] = await Promise.all([draft(acme, a.messageId), draft(acme, b.messageId)]);
    expect(ma.doGenerateCalls.length + mb.doGenerateCalls.length).toBe(1);
  });

  it("regenerate is refused up front when the budget is spent, and keeps the current draft", async () => {
    clock = new Date("2026-11-10T09:00:00Z");
    const email = await receive(9);
    await draft(acme, email.messageId);
    await db.withTenant(acme, (tx) =>
      recordUsage(tx, acme, "2026-11-10", { inputTokens: 500, outputTokens: 0 }),
    );
    const app = createApp({
      db,
      files,
      logger,
      inboundSecret: undefined,
      dailyTokenBudget: budget,
      now,
      authenticate: async () => ({
        tenantId: acme,
        actor: { type: "agent", id: "t" },
        scopes: new Set(["tickets:read", "drafts:write"] as const),
      }),
    });
    const res = await app.request(`/v1/tickets/${email.ticketId}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenerate: true }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "daily_budget_reached" });
    const drafts = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, email.ticketId)),
    );
    expect(drafts.map((d) => d.status)).toEqual(["pending"]);
  });

  it("a hand-written draft clears the pause", async () => {
    const email = await receive(10);
    await draft(acme, email.messageId); // still 2026-11-10, over budget: paused
    expect((await ticket(acme, email.ticketId))?.aiPausedReason).toBe("daily_budget");
    const app = createApp({
      db,
      files,
      logger,
      inboundSecret: undefined,
      dailyTokenBudget: budget,
      now,
      authenticate: async () => ({
        tenantId: acme,
        actor: { type: "agent", id: "t" },
        scopes: new Set(["tickets:read", "drafts:write"] as const),
      }),
    });
    const res = await app.request(`/v1/tickets/${email.ticketId}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Hi Jane, answering by hand." }),
    });
    expect(res.status).toBe(201);
    expect((await ticket(acme, email.ticketId))?.aiPausedReason).toBeNull();
  });

  it("resets at UTC midnight, and a new draft clears the pause", async () => {
    clock = new Date("2026-11-08T00:00:01Z");
    const email = await receive(5);
    const paused = await receive(6);
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.tickets)
        .set({ aiPausedReason: "daily_budget" })
        .where(eq(schema.tickets.id, paused.ticketId)),
    );
    const model = await draft(acme, email.messageId);
    expect(model.doGenerateCalls).toHaveLength(1);
    await draft(acme, paused.messageId);
    expect((await ticket(acme, paused.ticketId))?.aiPausedReason).toBeNull();
  });
});

describe("per-workspace AI budget", () => {
  // The env value (`budget`, 200) is the server-wide ceiling; these run on the Other workspace.
  const usageFor = (tenantId: string, scopes: Scope[]) =>
    createApp({
      db,
      files,
      logger,
      inboundSecret: undefined,
      dailyTokenBudget: budget,
      now,
      authenticate: async () => ({
        tenantId,
        actor: { type: "agent", id: "t" },
        scopes: new Set(scopes),
      }),
    });

  it("a workspace budget below the ceiling is enforced", async () => {
    clock = new Date("2026-12-01T09:00:00Z");
    expect(await setAiBudget(db, { tenantId: other, budget: 100 })).toEqual({ ok: true });
    const [a, b] = [await receive(20, "help@other.test"), await receive(21, "help@other.test")];
    expect((await draft(other, a.messageId)).doGenerateCalls).toHaveLength(1);
    // 120 used: under the ceiling, but over the workspace's own 100.
    expect((await draft(other, b.messageId)).doGenerateCalls).toHaveLength(0);
    expect((await ticket(other, b.ticketId))?.aiPausedReason).toBe("daily_budget");

    const res = await usageFor(other, ["tickets:read"]).request("/v1/ai-usage");
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

    const res = await usageFor(other, ["tickets:read"]).request("/v1/ai-usage");
    expect(await res.json()).toMatchObject({ dailyTokenBudget: budget, remainingTokens: 0 });
  });

  it("a workspace token can't change its own budget", async () => {
    await setAiBudget(db, { tenantId: other, budget: 50 });
    const app = usageFor(other, ["tickets:read", "workspace:admin", "drafts:write"]);
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
    const res = await usageFor(other, ["tickets:read"]).request("/v1/ai-usage");
    expect(await res.json()).toMatchObject({ dailyTokenBudget: budget });
  });

  it("refuses an unknown workspace and a negative budget", async () => {
    expect(
      await setAiBudget(db, { tenantId: "00000000-0000-7000-8000-000000000000", budget: 10 }),
    ).toEqual({ ok: false, reason: "workspace_not_found" });
    await expect(setAiBudget(db, { tenantId: other, budget: -1 })).rejects.toThrow();
  });
});
