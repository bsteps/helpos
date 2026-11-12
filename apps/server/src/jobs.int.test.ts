import { mockEmbeddingModel, routedMockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  type Database,
  eq,
  schema,
  sql,
  uuidv7,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { handleDraftGaveUp } from "./drafts/draft-worker.ts";
import { handleNoticeGaveUp } from "./drafts/notice-worker.ts";
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

const conversationOf = async (conversationId: string) => {
  const [conversation] = await db.withTenant(acme, (tx) =>
    tx.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)),
  );
  return conversation;
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
    embeddingModel: mockEmbeddingModel(),
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
  it("marks the conversation draft_failed, with an audit event, when every try fails", async () => {
    const email = await receiveEmail(`Hi, ${providerDown}, can you help?`);
    await expect
      .poll(async () => (await conversationOf(email.conversationId))?.aiPausedReason, eventually)
      .toBe("draft_failed");
    expect(await auditActions(email.conversationId)).toContain("ai.draft_failed");
    const drafts = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, email.conversationId)),
    );
    expect(drafts).toEqual([]);
  });

  it("leaves a conversation alone when the message got a draft meanwhile", async () => {
    const email = await receiveEmail("Hi, where is my order?");
    await expect
      .poll(
        async () =>
          (
            await db.withTenant(acme, (tx) =>
              tx
                .select()
                .from(schema.drafts)
                .where(eq(schema.drafts.conversationId, email.conversationId)),
            )
          ).length,
        eventually,
      )
      .toBe(1);
    await db.withTenant(acme, (tx) =>
      handleDraftGaveUp({ tenantId: acme, messageId: email.messageId }, tx),
    );
    expect((await conversationOf(email.conversationId))?.aiPausedReason).toBeNull();
    expect(await auditActions(email.conversationId)).not.toContain("ai.draft_failed");
  });
});

describe("asking the AI again after it gave up", () => {
  it("clears draft_failed while the new try runs, and sets it again when that fails too", async () => {
    const email = await receiveEmail(`Hi, ${providerDown} once more, please help?`);
    await expect
      .poll(async () => (await conversationOf(email.conversationId))?.aiPausedReason, eventually)
      .toBe("draft_failed");

    const app = createApp(helpos.services, {
      authenticate: async () => ({
        tenantId: acme,
        actor: { type: "agent", id: "test-agent" },
        scopes: new Set(["conversations:read", "drafts:write"]),
      }),
    });
    const res = await app.request(`/v1/conversations/${email.conversationId}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ regenerate: true }),
    });
    expect(res.status).toBe(202);
    // The new try needs a retry delay to fail, so right now nothing has marked the conversation again.
    expect((await conversationOf(email.conversationId))?.aiPausedReason).toBeNull();
    // The model is still down: the second try gives up too and the mark comes back.
    await expect
      .poll(async () => (await conversationOf(email.conversationId))?.aiPausedReason, eventually)
      .toBe("draft_failed");
    expect(
      (await auditActions(email.conversationId)).filter((a) => a === "ai.draft_failed"),
    ).toHaveLength(2);
  });

  it("can't end up with draft_failed next to a draft a person writes at the same time", async () => {
    const email = await receiveEmail("Hi, a question nobody has answered yet.");
    // Wait out the real worker's own draft, then drop it so the message has none.
    await expect
      .poll(
        async () =>
          (
            await db.withTenant(acme, (tx) =>
              tx
                .select()
                .from(schema.drafts)
                .where(eq(schema.drafts.conversationId, email.conversationId)),
            )
          ).length,
        eventually,
      )
      .toBe(1);
    await db.withTenant(acme, (tx) =>
      tx.delete(schema.drafts).where(eq(schema.drafts.conversationId, email.conversationId)),
    );

    // A person's draft is being written: it holds the conversation's lock and isn't committed yet.
    let release: () => void = () => {};
    const released = new Promise<void>((done) => {
      release = done;
    });
    let holding: () => void = () => {};
    const holdsLock = new Promise<void>((done) => {
      holding = done;
    });
    const person = db.withTenant(acme, async (tx) => {
      await tx
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, email.conversationId))
        .for("update");
      await tx.insert(schema.drafts).values({
        tenantId: acme,
        conversationId: email.conversationId,
        messageId: email.messageId,
        body: "Written by a person",
      });
      holding();
      await released;
    });
    await holdsLock;

    // The give-up runs meanwhile and has to wait for the person's transaction. Once it is
    // seen waiting, the person's draft is committed and the give-up carries on: it must then
    // find the draft. (Without the lock, it already looked before the draft existed.)
    const giveUp = db.withTenant(acme, (tx) =>
      handleDraftGaveUp({ tenantId: acme, messageId: email.messageId }, tx),
    );
    await expect
      .poll(
        async () =>
          (
            await db.withTenant(acme, (tx) =>
              tx.execute(sql`select 1 from pg_stat_activity where wait_event_type = 'Lock'`),
            )
          ).length,
        eventually,
      )
      .toBeGreaterThan(0);
    release();
    await Promise.all([person, giveUp]);

    expect((await conversationOf(email.conversationId))?.aiPausedReason).toBeNull();
    expect(await auditActions(email.conversationId)).not.toContain("ai.draft_failed");
  });
});

describe("draft-notice gives up", () => {
  it("records on the conversation that the owners weren't told, and the draft still waits", async () => {
    smtpDown = true;
    try {
      const email = await receiveEmail("Hi, I was charged twice.");
      await expect
        .poll(() => auditActions(email.conversationId), eventually)
        .toContain("draft.notice_failed");
      const actions = await auditActions(email.conversationId);
      expect(actions).not.toContain("draft.notice_sent");
      const [draft] = await db.withTenant(acme, (tx) =>
        tx
          .select()
          .from(schema.drafts)
          .where(eq(schema.drafts.conversationId, email.conversationId)),
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
            state: { status: "ready" },
          },
        ])
        .returning({ id: schema.knowledgeSources.id }),
    );
    if (!pending || !ready) throw new Error("no sources");
    for (const id of [pending.id, ready.id]) {
      await db.withTenant(acme, (tx) =>
        handleIngestGaveUp({ tenantId: acme, sourceId: id, requests: 0 }, tx),
      );
    }
    const rows = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.tenantId, acme)),
    );
    expect(rows.find((r) => r.id === pending.id)).toMatchObject({
      state: { status: "failed", reason: { code: "ingest_error" } },
    });
    expect(rows.find((r) => r.id === ready.id)).toMatchObject({ state: { status: "ready" } });
    expect(await auditActions(pending.id)).toEqual(["knowledge_source.failed"]);
    expect(await auditActions(ready.id)).toEqual([]);
  });

  it("leaves a source alone when an edit asked for a newer ingest, and that edit still gets ingested", async () => {
    // Job 1 queued for the first text, then the user edits (the count goes 0 -> 1). Job 1's
    // last try gives up. Failing the source would make the edit's own job quit as "not
    // pending", and the new text would never be ingested.
    const [edited] = await db.withTenant(acme, (tx) =>
      tx
        .insert(schema.knowledgeSources)
        .values({
          tenantId: acme,
          slug: "edited-doc",
          kind: "markdown",
          title: "E",
          content: "The edited text",
          ingestRequests: 1,
        })
        .returning({ id: schema.knowledgeSources.id }),
    );
    if (!edited) throw new Error("no source");
    await db.withTenant(acme, (tx) =>
      handleIngestGaveUp({ tenantId: acme, sourceId: edited.id, requests: 0 }, tx),
    );
    expect(await auditActions(edited.id)).toEqual([]);
    // The give-up queued a run for the newer request, and the real worker ingests it.
    await expect
      .poll(async () => {
        const [row] = await db.withTenant(acme, (tx) =>
          tx
            .select({ state: schema.knowledgeSources.state })
            .from(schema.knowledgeSources)
            .where(eq(schema.knowledgeSources.id, edited.id)),
        );
        return row?.state.status;
      }, eventually)
      .toBe("ready");
  });
});

describe("github.recheck-issue gives up", () => {
  it("records on the conversation that the issue's state may be stale", async () => {
    const email = await receiveEmail("Hi, the export is broken.");
    const linkId = uuidv7();
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        id: linkId,
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/app",
        issueNumber: 7,
        issueUrl: "https://github.com/acme/app/issues/7",
        state: "open",
      }),
    );
    await db.withTenant(acme, (tx) => handleRecheckGaveUp({ tenantId: acme, linkId }, tx));
    expect(await auditActions(email.conversationId)).toContain("github_issue.recheck_failed");
    const [link] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.conversationGithubIssues)
        .where(eq(schema.conversationGithubIssues.id, linkId)),
    );
    expect(link?.state).toBe("open");
  });
});

describe("give-up handlers stay in their tenant", () => {
  it("another workspace's job can't mark this workspace's conversation, draft, source or link", async () => {
    const email = await receiveEmail(`Hi, ${providerDown} again, help?`);
    await expect
      .poll(async () => (await conversationOf(email.conversationId))?.aiPausedReason, eventually)
      .toBe("draft_failed");
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.conversations)
        .set({ aiPausedReason: null })
        .where(eq(schema.conversations.id, email.conversationId)),
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
    const [draft] = await db.withTenant(acme, (tx) =>
      tx
        .insert(schema.drafts)
        .values({
          tenantId: acme,
          conversationId: email.conversationId,
          messageId: email.messageId,
          body: "Pending, waiting for its notice.",
        })
        .returning({ id: schema.drafts.id }),
    );
    if (!draft) throw new Error("no draft");
    const linkId = uuidv7();
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        id: linkId,
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/app",
        issueNumber: 8,
        issueUrl: "https://github.com/acme/app/issues/8",
        state: "open",
      }),
    );
    const before = (await auditActions(email.conversationId)).length;

    // Tenant B's payloads naming tenant A's rows: RLS shows B nothing of A's, so nothing changes.
    await db.withTenant(other, async (tx) => {
      await handleDraftGaveUp({ tenantId: other, messageId: email.messageId }, tx);
      await handleIngestGaveUp({ tenantId: other, sourceId: source.id, requests: 0 }, tx);
      await handleNoticeGaveUp({ tenantId: other, draftId: draft.id }, tx);
      await handleRecheckGaveUp({ tenantId: other, linkId }, tx);
    });

    expect((await conversationOf(email.conversationId))?.aiPausedReason).toBeNull();
    expect((await auditActions(email.conversationId)).length).toBe(before);
    const [row] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, source.id)),
    );
    expect(row?.state.status).toBe("pending");
    expect(await auditActions(source.id)).toEqual([]);
    const otherActions = (
      await db.withTenant(other, (tx) => tx.select().from(schema.auditEvents))
    ).map((e) => e.action);
    expect(otherActions).not.toContain("ai.draft_failed");
    expect(otherActions).not.toContain("knowledge_source.failed");
    expect(otherActions).not.toContain("draft.notice_failed");
    expect(otherActions).not.toContain("github_issue.recheck_failed");
  });
});
