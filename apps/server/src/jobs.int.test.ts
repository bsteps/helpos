import { routedMockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  type Database,
  eq,
  schema,
  uuidv7,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleDraftGaveUp } from "./drafts/draft-worker.ts";
import { handleRecheckGaveUp } from "./github/recheck.ts";
import { ingestEmail } from "./inbound-email/ingest.ts";
import { handleIngestGaveUp } from "./knowledge/ingest-worker.ts";
import { composeServer, type Server } from "./server.ts";
import { initWorkspace } from "./workspaces/init-workspace.ts";

// Every job leaves a visible mark when it fails for good, instead of silently leaving its work
// undone. Real Postgres and pg-boss; the worker is the real one, built by composeServer(), with
// one quick retry so giving up takes seconds.

/** An email with this in it makes the AI fail every try, as if the provider were down. */
const providerDown = "provider-down";
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let helpos: Server;
let acme: string;
let other: string;
/** While true, every email the worker sends fails, as when the mail server is down. */
let smtpDown = false;
const sent = vi.fn();

let emailCount = 0;
async function receiveEmail(body: string) {
  emailCount++;
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    "To: support@acme.test",
    `Subject: Question ${emailCount}`,
    `Message-ID: <question-${emailCount}@customer.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return result;
}

/** Jobs run in the background: poll until the state shows, up to 30 s. */
const eventually = { timeout: 30_000 };

const ticketOf = async (ticketId: string) => {
  const [ticket] = await db.withTenant(acme, (tx) =>
    tx.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)),
  );
  return ticket;
};
const auditActions = async (targetId: string) =>
  (
    await db.withTenant(acme, (tx) =>
      tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, targetId)),
    )
  ).map((e) => e.action);

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
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
    model: routedMockModel((email) => {
      if (email.includes(providerDown)) throw new Error("503 the AI provider is down");
      return { text: "Thanks, we're on it." };
    }),
    transport: {
      send: async (message) => {
        if (smtpDown) throw new Error("SMTP down");
        sent(message);
      },
      close: () => {},
    },
    auth,
    config: {
      noticeDelaySeconds: 0,
      jobRetry: { limit: 1, delaySeconds: 1, backoff: false },
    },
  });
  await helpos.startWorker();
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
  await helpos?.runner.stop();
  await auth?.close();
  await db?.close();
  await testDb?.stop();
});

describe("draft-reply gives up", () => {
  it("marks the ticket draft_failed, with an audit event, when every try fails", async () => {
    const email = await receiveEmail(`Hi, ${providerDown}, can you help?`);
    await expect
      .poll(async () => (await ticketOf(email.ticketId))?.aiPausedReason, eventually)
      .toBe("draft_failed");
    expect(await auditActions(email.ticketId)).toContain("ai.draft_failed");
    const drafts = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, email.ticketId)),
    );
    expect(drafts).toEqual([]);
  });

  it("leaves a ticket alone when the message got a draft meanwhile", async () => {
    const email = await receiveEmail("Hi, where is my order?");
    await expect
      .poll(
        async () =>
          (
            await db.withTenant(acme, (tx) =>
              tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, email.ticketId)),
            )
          ).length,
        eventually,
      )
      .toBe(1);
    await db.withTenant(acme, (tx) =>
      handleDraftGaveUp({ tenantId: acme, messageId: email.messageId }, tx),
    );
    expect((await ticketOf(email.ticketId))?.aiPausedReason).toBeNull();
    expect(await auditActions(email.ticketId)).not.toContain("ai.draft_failed");
  });
});

describe("draft-notice gives up", () => {
  it("records on the ticket that the owners weren't told, and the draft still waits", async () => {
    smtpDown = true;
    try {
      const email = await receiveEmail("Hi, I was charged twice.");
      await expect
        .poll(() => auditActions(email.ticketId), eventually)
        .toContain("draft.notice_failed");
      const actions = await auditActions(email.ticketId);
      expect(actions).not.toContain("draft.notice_sent");
      const [draft] = await db.withTenant(acme, (tx) =>
        tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, email.ticketId)),
      );
      expect(draft?.status).toBe("pending");
    } finally {
      smtpDown = false;
    }
  });
});

describe("ingest-source gives up", () => {
  it("marks a pending source failed with ingest_error, audited, and leaves a ready one", async () => {
    const [pending, ready] = await db.withTenant(acme, (tx) =>
      tx
        .insert(schema.knowledgeSources)
        .values([
          { tenantId: acme, slug: "pending-doc", kind: "markdown", title: "P", content: "p" },
          {
            tenantId: acme,
            slug: "ready-doc",
            kind: "markdown",
            title: "R",
            content: "r",
            status: "ready",
          },
        ])
        .returning({ id: schema.knowledgeSources.id }),
    );
    if (!pending || !ready) throw new Error("no sources");
    for (const id of [pending.id, ready.id]) {
      await db.withTenant(acme, (tx) => handleIngestGaveUp({ tenantId: acme, sourceId: id }, tx));
    }
    const rows = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.tenantId, acme)),
    );
    expect(rows.find((r) => r.id === pending.id)).toMatchObject({
      status: "failed",
      error: "ingest_error",
    });
    expect(rows.find((r) => r.id === ready.id)).toMatchObject({ status: "ready", error: null });
    expect(await auditActions(pending.id)).toEqual(["knowledge_source.failed"]);
    expect(await auditActions(ready.id)).toEqual([]);
  });
});

describe("github.recheck-issue gives up", () => {
  it("records on the ticket that the issue's state may be stale", async () => {
    const email = await receiveEmail("Hi, the export is broken.");
    const linkId = uuidv7();
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.ticketGithubIssues).values({
        id: linkId,
        tenantId: acme,
        ticketId: email.ticketId,
        repo: "acme/app",
        issueNumber: 7,
        issueUrl: "https://github.com/acme/app/issues/7",
        state: "open",
      }),
    );
    await db.withTenant(acme, (tx) => handleRecheckGaveUp({ tenantId: acme, linkId }, tx));
    expect(await auditActions(email.ticketId)).toContain("github_issue.recheck_failed");
    const [link] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.ticketGithubIssues).where(eq(schema.ticketGithubIssues.id, linkId)),
    );
    expect(link?.state).toBe("open");
  });
});

describe("give-up handlers stay in their tenant", () => {
  it("another workspace's job can't mark this workspace's ticket, source or link", async () => {
    const email = await receiveEmail(`Hi, ${providerDown} again, help?`);
    await expect
      .poll(async () => (await ticketOf(email.ticketId))?.aiPausedReason, eventually)
      .toBe("draft_failed");
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.tickets)
        .set({ aiPausedReason: null })
        .where(eq(schema.tickets.id, email.ticketId)),
    );
    const [source] = await db.withTenant(acme, (tx) =>
      tx
        .insert(schema.knowledgeSources)
        .values({
          tenantId: acme,
          slug: "isolated-doc",
          kind: "markdown",
          title: "I",
          content: "i",
        })
        .returning({ id: schema.knowledgeSources.id }),
    );
    if (!source) throw new Error("no source");
    const before = (await auditActions(email.ticketId)).length;

    // Tenant B's payloads naming tenant A's rows: RLS shows B nothing of A's, so nothing changes.
    await db.withTenant(other, async (tx) => {
      await handleDraftGaveUp({ tenantId: other, messageId: email.messageId }, tx);
      await handleIngestGaveUp({ tenantId: other, sourceId: source.id }, tx);
    });

    expect((await ticketOf(email.ticketId))?.aiPausedReason).toBeNull();
    expect((await auditActions(email.ticketId)).length).toBe(before);
    const [row] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, source.id)),
    );
    expect(row?.status).toBe("pending");
    expect(await auditActions(source.id)).toEqual([]);
    const otherActions = (
      await db.withTenant(other, (tx) => tx.select().from(schema.auditEvents))
    ).map((e) => e.action);
    expect(otherActions).not.toContain("ai.draft_failed");
    expect(otherActions).not.toContain("knowledge_source.failed");
  });
});
