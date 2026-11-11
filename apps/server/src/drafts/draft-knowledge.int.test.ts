import { type LanguageModel, maxKnowledgeArticles } from "@helpos/ai";
import { failingModel, mockModel, refusingModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  type KnowledgeHit,
  schema,
  sql,
  tenantTransactions,
  uuidv7,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aiBudget } from "../ai-budget/budget.ts";
import { usageOn } from "../ai-budget/testing.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { SearchError, type SearchProvider } from "../knowledge/search.ts";
import { defaultConfig, systemClock } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { handleDraftReply } from "./draft-worker.ts";

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

async function draftWith(
  search: SearchProvider,
  messageId: string,
  model: LanguageModel = mockModel({ text: "A teammate will follow up." }),
) {
  await handleDraftReply({
    model,
    logger,
    search,
    clock: systemClock,
    config: { ...defaultConfig, dailyTokenBudget: 1_000_000 },
  })({ tenantId: acme, messageId }, tenantTransactions(db, acme));
}

const usedToday = () => usageOn(db, acme).then((u) => u.totalTokens);

/** A real source, since citations reference one. */
async function addSource(): Promise<string> {
  const [row] = await db.withTenant(acme, (tx) =>
    tx
      .insert(schema.knowledgeSources)
      .values({
        tenantId: acme,
        slug: `doc-${++received}`,
        kind: "markdown",
        title: "Doc",
        content: "x",
      })
      .returning({ id: schema.knowledgeSources.id }),
  );
  if (!row) throw new Error("no row");
  return row.id;
}

const hit = (sourceId: string, i: number): KnowledgeHit => ({
  chunkId: uuidv7(),
  sourceId,
  title: `Passage ${i}`,
  url: null,
  content: `Fact number ${i}.`,
  visibility: "public",
  distance: i / 100,
});

const draftsOf = (conversationId: string) =>
  db.withTenant(acme, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, conversationId)),
  );

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
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
  await auth?.close();
  await testDb?.stop();
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
        search: async (transaction) => {
          await transaction((tx) => tx.execute(sql`select 1 / 0`));
          return { hits: [], tokens: 0 };
        },
      }),
    ],
  ])("drafts without knowledge when %s", async (_, provider) => {
    const email = await receive(++received);
    await draftWith(provider(), email.messageId);

    const [draft] = await draftsOf(email.conversationId);
    if (!draft) throw new Error("no draft was written");
    expect(draft).toMatchObject({ body: "A teammate will follow up.", status: "pending" });
    const citations = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.draftCitations).where(eq(schema.draftCitations.draftId, draft.id)),
    );
    expect(citations).toEqual([]);
    const events = await db.withTenant(acme, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, draft.id)),
    );
    expect(events).toEqual([{ action: "draft.created" }]);
  });
});

describe("drafting with knowledge: spend and limits", () => {
  it("counts the search's embedding tokens even when the model then refuses the call", async () => {
    const email = await receive(++received);
    const before = await usageOn(db, acme);
    const search: SearchProvider = { search: async () => ({ hits: [], tokens: 42 }) };
    // The job fails, so pg-boss retries it. Each attempt's embedding call was paid for, so the
    // budget must see it, or retries could run past the cap uncounted. The refused model call
    // wasn't billed.
    await expect(draftWith(search, email.messageId, refusingModel())).rejects.toThrow();
    const after = await usageOn(db, acme);
    expect(after.totalTokens - before.totalTokens).toBe(42);
    expect(after.calls - before.calls).toBe(1);
    expect(after.reservedTokens).toBe(before.reservedTokens);
    expect(await draftsOf(email.conversationId)).toEqual([]);
  });

  it("counts the most a failed call could cost when its cost can't be told", async () => {
    const email = await receive(++received);
    const before = await usageOn(db, acme);
    const search: SearchProvider = { search: async () => ({ hits: [], tokens: 42 }) };
    // A dropped connection may still be billed: the budget may overcount, never undercount.
    await expect(draftWith(search, email.messageId, failingModel())).rejects.toThrow();
    const after = await usageOn(db, acme);
    const counted = after.totalTokens - before.totalTokens;
    // The search, and the bound of the prompt it really sent (no passages) with the output cap:
    // not the reservation, which counted five passages at their longest.
    expect(counted).toBeGreaterThan(42 + 2_000);
    expect(counted).toBeLessThan(5 * 9_000);
    expect(after.reservedTokens).toBe(before.reservedTokens);
  });

  it("counts a search's embedding tokens when its query then fails", async () => {
    const email = await receive(++received);
    const before = await usedToday();
    const search: SearchProvider = {
      search: async () => {
        throw new SearchError(17, { cause: new Error("division by zero") });
      },
    };
    await draftWith(search, email.messageId);
    expect(await draftsOf(email.conversationId)).toHaveLength(1);
    expect((await usedToday()) - before).toBe(17);
  });

  it("holds no budget lock while the search embeds the email", async () => {
    const email = await receive(++received);
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let markStarted = () => {};
    const started = new Promise<void>((done) => {
      markStarted = done;
    });
    const slow: SearchProvider = {
      search: async () => {
        markStarted();
        await gate;
        return { hits: [], tokens: 0 };
      },
    };
    const run = draftWith(slow, email.messageId);
    await started;
    // Another call's reservation updates the same row. Were its lock held through the search,
    // this would time out.
    const budget = aiBudget({ clock: systemClock, config: { dailyTokenBudget: 1e9 }, logger });
    const reserved = await db.withTenant(acme, async (tx) => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      return budget.reserve(tx, acme, 0);
    });
    expect(reserved).toMatchObject({ tenantId: acme, tokens: 0 });
    release();
    await run;
    expect(await draftsOf(email.conversationId)).toHaveLength(1);
  });

  it("doesn't pay the model when another job drafted the message meanwhile", async () => {
    const email = await receive(++received);
    const before = await usedToday();
    // Stands in for an overlapping job that drafted the message while this one searched.
    const raced: SearchProvider = {
      search: async (transaction) => {
        await transaction((tx) =>
          tx.insert(schema.drafts).values({
            tenantId: acme,
            conversationId: email.conversationId,
            messageId: email.messageId,
            body: "Drafted by the other job.",
          }),
        );
        return { hits: [], tokens: 5 };
      },
    };
    const model = mockModel({ text: "A second draft." });
    await draftWith(raced, email.messageId, model);
    expect(model.doGenerateCalls).toEqual([]);
    expect((await draftsOf(email.conversationId)).map((d) => d.body)).toEqual([
      "Drafted by the other job.",
    ]);
    // The search was paid for, so it counts.
    expect((await usedToday()) - before).toBe(5);
  });

  it("stores citations only for the passages the model was shown", async () => {
    const sourceId = await addSource();
    const hits = Array.from({ length: maxKnowledgeArticles + 3 }, (_, i) => hit(sourceId, i));
    const email = await receive(++received);
    await draftWith({ search: async () => ({ hits, tokens: 0 }) }, email.messageId);
    const [draft] = await draftsOf(email.conversationId);
    if (!draft) throw new Error("no draft was written");
    const citations = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.draftCitations).where(eq(schema.draftCitations.draftId, draft.id)),
    );
    expect(citations.map((c) => c.rank).sort((a, b) => a - b)).toEqual(
      Array.from({ length: maxKnowledgeArticles }, (_, i) => i),
    );
  });
});
