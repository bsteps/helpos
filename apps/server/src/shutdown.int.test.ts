import { hangingModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  type Database,
  eq,
  schema,
  sql,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usageOn } from "./ai-budget/testing.ts";
import { ingestEmail } from "./inbound-email/ingest.ts";
import { composeServer, type Server } from "./server.ts";
import { initWorkspace } from "./workspaces/init-workspace.ts";

// A deploy (or `docker stop`) while the AI is writing a draft. Real Postgres and pg-boss, and
// the worker built by composeServer(); the model never answers until it's aborted, like a slow
// provider. The stop must settle the call's budget reservation before the database closes,
// or it would hold the budget, and keep every other call `busy`, long after the restart.

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const model = hangingModel();

let testDb: TestDatabase;
let db: Database;
let jobsDb: Database;
let auth: AuthStore;
let helpos: Server;
let acme: string;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  jobsDb = createDatabase(testDb.jobsUrl);
  auth = createAuthStore(testDb.authUrl);
  helpos = composeServer({
    db,
    jobsUrl: testDb.jobsUrl,
    pollingIntervalSeconds: 0.5,
    onJobError: (error) => {
      throw error;
    },
    files,
    logger,
    model,
    auth,
    config: { dailyTokenBudget: 1_000_000 },
  });
  await helpos.startWorker();
  const a = await initWorkspace(
    { db, auth },
    { workspace: "Acme", mailbox: "support@acme.test", owner: "owner@acme.test" },
  );
  if (!a.ok) throw new Error("setup failed");
  acme = a.tenantId;
});

afterAll(async () => {
  await helpos?.stopWorker();
  await auth?.close();
  await jobsDb?.close();
  await db?.close();
  await testDb?.stop();
});

describe("shutting down while an AI call is in flight", () => {
  it("aborts the call and settles its reservation before the worker stops", async () => {
    const raw = [
      "From: jane@customer.test",
      "To: support@acme.test",
      "Subject: Export is broken",
      "Message-ID: <shutdown-1@customer.test>",
      "Content-Type: text/plain",
      "",
      "My export button does nothing.",
    ].join("\r\n");
    const email = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
    if (email.kind !== "created") throw new Error(email.kind);

    // The worker picks the job up, reserves, and is now waiting on the model.
    await expect.poll(() => model.doGenerateCalls.length, { timeout: 30_000 }).toBe(1);
    const during = await usageOn(db, acme);
    expect(during.reservedTokens).toBeGreaterThan(0);

    await helpos.stopWorker();

    // Settled while the database was still open: the reservation is gone, and the call, whose
    // cost can't be told, counts what it could have cost.
    const after = await usageOn(db, acme);
    expect(after.reservedTokens).toBe(0);
    expect(after.totalTokens).toBeGreaterThan(0);
    expect(after.totalTokens).toBeLessThanOrEqual(during.reservedTokens);
    expect(after.calls).toBe(1);
    // No draft, and the job is left to be tried again after the restart.
    const drafts = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, email.conversationId)),
    );
    expect(drafts).toEqual([]);
    const jobs = await jobsDb.withTenant(acme, (tx) =>
      tx.execute<{ state: string }>(
        sql`select state from pgboss.job where name = 'draft-reply'
            and data->>'messageId' = ${email.messageId}`,
      ),
    );
    expect(jobs.map((j) => j.state)).toEqual(["retry"]);
  });
});
