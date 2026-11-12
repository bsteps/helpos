import { mockEmbeddingModel, mockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  enqueue,
  eq,
  type JobRunner,
  schema,
  sql,
  tenantTransactions,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { safeFetch } from "@helpos/safe-fetch";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { handleDraftGaveUp, handleDraftReply } from "../drafts/draft-worker.ts";
import { draftReplyJob } from "../drafts/jobs.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { handleIngestGaveUp, handleIngestSource } from "../knowledge/ingest-worker.ts";
import { ingestSourceJob } from "../knowledge/jobs.ts";
import { defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { aiBudget } from "./budget.ts";

const budget = 200;
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
let clock = new Date();
const now = () => clock;

let testDb: TestDatabase;
let db: Database;
let jobsDb: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;

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
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: () => {},
    pollingIntervalSeconds: 0.5,
  });
  await runner.start();
  await ensureJobQueues(runner, defaultConfig);
  const a = await initWorkspace(
    { db, auth },
    { workspace: "Acme", mailbox: "support@acme.test", owner: "owner@acme.test" },
  );
  if (!a.ok) throw new Error("setup failed");
  acme = a.tenantId;
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await jobsDb?.close();
  await auth?.close();
  await testDb?.stop();
});

it("keeps a busy draft queued past the retry horizon, then drafts after release", async () => {
  const email = await receive(203);
  const paid = aiBudget({ clock: { now }, config: { dailyTokenBudget: budget }, logger });
  const held = await db.withTenant(acme, (tx) => paid.reserve(tx, acme, budget));
  if ("refused" in held) throw new Error("Expected a reservation");
  const release = Promise.withResolvers<void>();
  const spending = paid.spend(tenantTransactions(db, acme), held, () => release.promise, {
    of: () => ({ inputTokens: 0, outputTokens: 0 }),
    ofFailure: () => "none",
  });
  const model = mockModel(callCost);
  const gaveUp = vi.fn(handleDraftGaveUp);
  const worker = handleDraftReply({
    model,
    logger,
    clock: { now },
    config: { ...defaultConfig, dailyTokenBudget: budget },
  });
  const rows = () =>
    jobsDb.withTenant(acme, (tx) =>
      tx.execute<{
        state: string;
        retry_count: number;
        start_after: string;
      }>(sql`select state, retry_count, start_after from pgboss.job
    where name = 'draft-reply' and data->>'messageId' = ${email.messageId}`),
    );
  try {
    await runner.work(draftReplyJob, { steps: worker, onGiveUp: gaveUp });
    for (let attempt = 1; attempt <= 31; attempt++) {
      await expect
        .poll(async () => (await rows()).filter((row) => row.state === "completed").length, {
          timeout: 10_000,
        })
        .toBe(attempt);
      const queued = await rows();
      expect(queued.filter((row) => row.state === "created")).toHaveLength(1);
      expect(queued.every((row) => row.retry_count === 0)).toBe(true);
      const next = queued.find((row) => row.state === "created");
      expect(new Date(next?.start_after ?? 0).getTime()).toBeGreaterThanOrEqual(
        clock.getTime() + 30_000,
      );
      expect(await draftCount(acme, email.conversationId)).toBe(0);
      expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBeNull();
      expect(model.doGenerateCalls).toHaveLength(0);
      clock = new Date(clock.getTime() + 30_000);
      if (attempt === 31) {
        release.resolve();
        await spending;
      }
      // Advance only the waiting job's eligibility; pg-boss still claims and settles it.
      await jobsDb.withTenant(acme, (tx) =>
        tx.execute(sql`update pgboss.job
        set start_after = now() where name = 'draft-reply'
        and data->>'messageId' = ${email.messageId} and state = 'created'`),
      );
    }
    await expect.poll(() => draftCount(acme, email.conversationId), { timeout: 10_000 }).toBe(1);
    await expect
      .poll(async () => (await rows()).every((row) => row.state === "completed"))
      .toBe(true);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(gaveUp).not.toHaveBeenCalled();
    expect((await conversation(acme, email.conversationId))?.aiPausedReason).toBeNull();
  } finally {
    release.resolve();
    await spending;
  }
}, 60_000);

it("defers busy ingestion without erasing its earlier temporary failure", async () => {
  const retryAt = clock.toISOString();
  const paid = aiBudget({ clock: { now }, config: { dailyTokenBudget: budget }, logger });
  const held = await db.withTenant(acme, (tx) => paid.reserve(tx, acme, budget));
  if ("refused" in held) throw new Error("Expected a reservation");
  const release = Promise.withResolvers<void>();
  const spending = paid.spend(tenantTransactions(db, acme), held, () => release.promise, {
    of: () => ({ inputTokens: 0, outputTokens: 0 }),
    ofFailure: () => "none",
  });
  const sourceId = await db.withTenant(acme, async (tx) => {
    const [source] = await tx
      .insert(schema.knowledgeSources)
      .values({
        tenantId: acme,
        slug: "busy-source",
        kind: "markdown",
        title: "Help",
        content: "Reset your password.",
        state: {
          status: "waiting",
          reason: { code: "embedding_unavailable" },
          retryAt,
        },
        retryCount: 1,
      })
      .returning();
    if (!source) throw new Error("Expected source");
    await enqueue(tx, ingestSourceJob, {
      tenantId: acme,
      sourceId: source.id,
      requests: source.ingestRequests,
    });
    return source.id;
  });
  const source = () =>
    db
      .withTenant(acme, (tx) =>
        tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, sourceId)),
      )
      .then((rows) => rows[0]);
  const rows = () =>
    jobsDb.withTenant(acme, (tx) =>
      tx.execute<{ state: string; retry_count: number; start_after: string }>(
        sql`select state, retry_count, start_after from pgboss.job where name = 'ingest-source' and data->>'sourceId' = ${sourceId}`,
      ),
    );
  const gaveUp = vi.fn(handleIngestGaveUp);
  try {
    await runner.work(ingestSourceJob, {
      steps: handleIngestSource({
        embeddingModel: mockEmbeddingModel(),
        fetch: safeFetch,
        logger,
        clock: { now },
        config: { ...defaultConfig, dailyTokenBudget: budget },
      }),
      onGiveUp: gaveUp,
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect
        .poll(async () => (await rows()).filter((row) => row.state === "completed").length, {
          timeout: 10_000,
        })
        .toBe(attempt);
      const queued = await rows();
      expect(queued.filter((row) => row.state === "created")).toHaveLength(1);
      expect(queued.every((row) => row.retry_count === 0)).toBe(true);
      const next = queued.find((row) => row.state === "created");
      expect(new Date(next?.start_after ?? 0).getTime()).toBeGreaterThanOrEqual(
        clock.getTime() + 30_000,
      );
      expect(await source()).toMatchObject({
        state: {
          status: "waiting",
          reason: { code: "embedding_unavailable" },
          retryAt,
        },
        retryCount: 1,
      });
      clock = new Date(clock.getTime() + 30_000);
      if (attempt === 5) {
        release.resolve();
        await spending;
      }
      await jobsDb.withTenant(acme, (tx) =>
        tx.execute(
          sql`update pgboss.job set start_after = now() where name = 'ingest-source' and data->>'sourceId' = ${sourceId} and state = 'created'`,
        ),
      );
    }
    await expect
      .poll(source, { timeout: 10_000 })
      .toMatchObject({ state: { status: "ready" }, retryCount: 0, chunkCount: 1 });
    expect(gaveUp).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await spending;
  }
});
