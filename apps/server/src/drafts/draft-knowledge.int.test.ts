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
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestEmail } from "../inbound-email/ingest.ts";
import type { SearchProvider } from "../knowledge/search.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { handleDraftReply } from "./draft-worker.ts";
import { draftNoticeJob, draftReplyJob } from "./jobs.ts";

// Drafting when knowledge search breaks, against real Postgres. Drafts worked without
// knowledge before, so a broken search (provider down, bad key, a failed query) must not
// stop one. The test runs the draft handler itself; nothing works the queue.

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;
let received = 0;

async function receive(n: number) {
  const raw = [
    "From: jane@customer.test",
    "To: support@acme.test",
    `Subject: Refunds ${n}`,
    `Message-ID: <search-down-${n}@customer.test>`,
    "Content-Type: text/plain",
    "",
    "How long do refunds take?",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(result.kind);
  return result;
}

async function draftWith(search: SearchProvider, messageId: string) {
  await db.withTenant(acme, (tx) =>
    handleDraftReply({
      model: mockModel({ text: "A teammate will follow up." }),
      logger,
      dailyTokenBudget: 1_000_000,
      search,
    })({ tenantId: acme, messageId }, tx),
  );
}

const draftsOf = (ticketId: string) =>
  db.withTenant(acme, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, ticketId)),
  );

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await runner.ensureQueue(draftReplyJob);
  await runner.ensureQueue(draftNoticeJob);
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
  await auth?.close();
  await testDb?.container.stop();
});

describe("drafting when knowledge search fails", () => {
  it.each([
    [
      "the embedding call fails",
      (): SearchProvider => ({
        search: async () => {
          throw new Error("401 invalid api key");
        },
      }),
    ],
    [
      // Without a savepoint, this would abort the job's transaction and every query after it.
      "a search query fails",
      (): SearchProvider => ({
        search: async (tx) => {
          await tx.execute(sql`select 1 / 0`);
          return { hits: [], tokens: 0 };
        },
      }),
    ],
  ])("drafts without knowledge when %s", async (_, provider) => {
    const email = await receive(++received);
    logger.warn.mockClear();
    await draftWith(provider(), email.messageId);

    const [draft] = await draftsOf(email.ticketId);
    if (!draft) throw new Error("no draft was written");
    expect(draft).toMatchObject({ body: "A teammate will follow up.", status: "pending" });
    const citations = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.draftCitations).where(eq(schema.draftCitations.draftId, draft.id)),
    );
    expect(citations).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "knowledge search failed: drafting without it",
    );
  });
});
