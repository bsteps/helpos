import { refusingModel } from "@helpos/ai/testing";
import {
  createAuthStore,
  createDatabase,
  createJobRunner,
  eq,
  schema,
  sql,
  tenantTransactions,
} from "@helpos/db";
import { startTestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { expect, it, vi } from "vitest";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues, jobs } from "../jobs.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { aiBudget } from "./budget.ts";

it("retains real failures across multiple busy deferrals", async () => {
  const testDb = await startTestDatabase();
  const db = createDatabase(testDb.appUrl);
  const jobsDb = createDatabase(testDb.jobsUrl);
  const auth = createAuthStore(testDb.authUrl);
  const runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: () => {},
    pollingIntervalSeconds: 0.5,
  });
  try {
    await runner.start();
    await ensureJobQueues(runner, defaultConfig);
    const workspace = await initWorkspace(
      { db, auth },
      { workspace: "Acme", mailbox: "support@acme.test", owner: "owner@acme.test" },
    );
    if (!workspace.ok) throw new Error("setup failed");
    const tenantId = workspace.tenantId;
    const received = await ingestEmail(
      { db, files: createMemoryFileStore() },
      new TextEncoder().encode(
        [
          "From: jane@customer.test",
          "To: support@acme.test",
          "Subject: Retry allowance",
          "Message-ID: <busy-retry-allowance@customer.test>",
          "Content-Type: text/plain",
          "",
          "Please help.",
        ].join("\r\n"),
      ),
    );
    if (received.kind !== "created") throw new Error(received.kind);
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const clock = { now: () => new Date() };
    const config = { ...defaultConfig, dailyTokenBudget: 1_000_000 };
    const paid = aiBudget({ logger, clock, config });
    const model = refusingModel();
    const job = jobs.find((candidate) => candidate.queue === "draft-reply");
    if (!job) throw new Error("Expected the registered draft job");
    await job.start(
      runner,
      composeServices({
        db,
        files: createMemoryFileStore(),
        logger,
        clock,
        config,
        model,
        auth,
      }),
    );
    const rows = () =>
      jobsDb.withTenant(tenantId, (tx) =>
        tx.execute<{
          id: string;
          state: string;
          retry_limit: number;
          retry_count: number;
        }>(sql`select id, state, retry_limit, retry_count from pgboss.job
      where name = 'draft-reply' and data->>'messageId' = ${received.messageId}`),
      );
    const makeEligible = () =>
      jobsDb.withTenant(tenantId, (tx) =>
        tx.execute(
          sql`update pgboss.job set start_after = now() where name = 'draft-reply'
        and data->>'messageId' = ${received.messageId} and state in ('created', 'retry')`,
        ),
      );
    const fail = async (calls: number) => {
      await expect.poll(() => model.doGenerateCalls.length).toBe(calls);
      await expect.poll(async () => (await rows()).some((row) => row.state === "retry")).toBe(true);
    };
    const defer = async (remaining: number) => {
      const held = await db.withTenant(tenantId, (tx) =>
        paid.reserve(tx, tenantId, config.dailyTokenBudget),
      );
      if ("refused" in held) throw new Error("Expected a reservation");
      try {
        await makeEligible();
        await expect
          .poll(async () => (await rows()).filter((row) => row.state === "created").length)
          .toBe(1);
        const queued = (await rows()).find((row) => row.state === "created");
        expect(queued).toMatchObject({ retry_limit: remaining, retry_count: 0 });
        expect((await rows()).some((row) => row.state === "failed")).toBe(false);
      } finally {
        await paid.spend(tenantTransactions(db, tenantId), held, async () => undefined, {
          of: () => ({ inputTokens: 0, outputTokens: 0 }),
          ofFailure: () => "none",
        });
      }
      await makeEligible();
    };
    await fail(1);
    await makeEligible();
    await fail(2);
    await defer(1);
    await fail(3);
    await defer(0);
    await expect.poll(() => model.doGenerateCalls.length).toBe(4);
    await expect.poll(async () => (await rows()).some((row) => row.state === "failed")).toBe(true);
    expect(model.doGenerateCalls).toHaveLength(4);
    expect((await rows()).every((row) => ["completed", "failed"].includes(row.state))).toBe(true);
    const [conversation] = await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, received.conversationId)),
    );
    expect(conversation?.aiPausedReason).toBe("draft_failed");
    expect(
      logger.error.mock.calls.filter(
        (call) => call[1] === "job failed on its last retry: marked as failed",
      ),
    ).toHaveLength(1);
  } finally {
    await runner.stop();
    await db.close();
    await jobsDb.close();
    await auth.close();
    await testDb.stop();
  }
}, 60_000);
