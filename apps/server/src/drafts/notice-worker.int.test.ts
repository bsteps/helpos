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
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ingestEmail } from "../inbound-email/ingest.ts";
import type { EmailTransport } from "../outbound-email/transport.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { handleDraftReply } from "./draft-worker.ts";
import { draftNoticeJob, draftReplyJob } from "./jobs.ts";
import { handleDraftNotice, noticeReplyTo } from "./notice-worker.ts";

// The notice handler on its own, with nothing working the queue, so each case runs exactly the
// jobs it names. The end-to-end Mailpit case is in drafts.test.ts.

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;

let n = 0;
async function pendingDraft() {
  n++;
  const raw = [
    "From: jane@customer.test",
    "To: support@acme.test",
    `Subject: Question ${n}`,
    `Message-ID: <notice-${n}@customer.test>`,
    "Content-Type: text/plain",
    "",
    `Question number ${n}?`,
  ].join("\r\n");
  const email = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (email.kind !== "created") throw new Error(email.kind);
  await db.withTenant(acme, (tx) =>
    handleDraftReply({ model: mockModel({ text: "On it." }), logger, dailyTokenBudget: 1e6 })(
      { tenantId: acme, messageId: email.messageId },
      tx,
    ),
  );
  const [draft] = await db.withTenant(acme, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, email.ticketId)),
  );
  if (!draft) throw new Error("no draft");
  return draft;
}

/** Runs the notice job now. Delay 0 by default, so the drafts these tests make count as old. */
function notify(draftId: string, noticeDelaySeconds = 0) {
  const send = vi.fn<EmailTransport["send"]>();
  const run = db.withTenant(acme, (tx) =>
    handleDraftNotice({
      transport: { send, close: () => {} },
      auth,
      publicUrl: "http://helpdesk.test",
      logger,
      noticeDelaySeconds,
    })({ tenantId: acme, draftId }, tx),
  );
  return run.then(() => send);
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: () => {},
    pollingIntervalSeconds: 0.5,
  });
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
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.container.stop();
});

describe("draft notice worker", () => {
  it("emails only this workspace's owners, then nothing more within the window", async () => {
    const draft = await pendingDraft();
    const first = await notify(draft.id);
    expect(first).toHaveBeenCalledOnce();
    expect(first.mock.calls[0]?.[0]).toMatchObject({
      from: "support@acme.test",
      to: ["owner@acme.test"],
    });
    const raw = new TextDecoder().decode(first.mock.calls[0]?.[0].raw);
    // Answering the notice must not land in the support mailbox and open a ticket.
    expect(raw).toContain("Reply-To: no-reply@acme.test");
    expect(await notify(draft.id)).not.toHaveBeenCalled();
  });

  it("still notifies when a newer draft replaced the one the job was queued for", async () => {
    const old = await pendingDraft();
    // A hand-written draft replaces it while the old draft's notice job is still queued.
    await db.withTenant(acme, async (tx) => {
      await tx
        .update(schema.drafts)
        .set({ status: "discarded" })
        .where(eq(schema.drafts.id, old.id));
      await tx.insert(schema.drafts).values({
        tenantId: acme,
        ticketId: old.ticketId,
        messageId: old.messageId,
        body: "Hand-written.",
      });
    });
    expect(await notify(old.id)).toHaveBeenCalledOnce();
  });

  it("sends nothing once no draft on the ticket is pending", async () => {
    const draft = await pendingDraft();
    await db.withTenant(acme, (tx) =>
      tx.update(schema.drafts).set({ status: "discarded" }).where(eq(schema.drafts.id, draft.id)),
    );
    expect(await notify(draft.id)).not.toHaveBeenCalled();
  });

  it("Reply-To is never the helpdesk mailbox itself", () => {
    expect(noticeReplyTo("support@acme.test")).toBe("no-reply@acme.test");
    expect(noticeReplyTo("no-reply@acme.test")).toBe("no-reply-notices@acme.test");
  });

  it("a new draft after the owners approved the last one is notified, even inside the window", async () => {
    const first = await pendingDraft();
    expect(await notify(first.id)).toHaveBeenCalledOnce();
    await db.withTenant(acme, async (tx) => {
      await tx
        .update(schema.drafts)
        .set({ status: "approved", approvedAt: new Date(Date.now() + 1_000) })
        .where(eq(schema.drafts.id, first.id));
      // A follow-up from the customer, answered by a new pending draft.
      const [msg] = await tx
        .insert(schema.messages)
        .values({
          tenantId: acme,
          ticketId: first.ticketId,
          direction: "inbound",
          fromAddress: "jane@customer.test",
          toAddresses: ["support@acme.test"],
          subject: "Follow-up",
          textBody: "Still broken.",
          references: [],
          rawFileKey: `${acme}/follow-up`,
        })
        .returning({ id: schema.messages.id });
      if (!msg) throw new Error("no message");
      await tx.insert(schema.drafts).values({
        tenantId: acme,
        ticketId: first.ticketId,
        messageId: msg.id,
        body: "A follow-up answer.",
      });
    });
    expect(await notify(first.id)).toHaveBeenCalledOnce();
  });

  // The real worker, from here on. Its own age check uses 2 s; drafts are still queued with
  // the default 5 minutes unless a job re-queues them.
  const workerSend = vi.fn<EmailTransport["send"]>();
  const sentFor = (ticketId: string) =>
    workerSend.mock.calls.filter(([m]) =>
      // Quoted-printable wraps long lines with "=" + CRLF, which can split the ticket ID.
      new TextDecoder().decode(m.raw).replaceAll("=\r\n", "").includes(ticketId),
    );

  it("a queued notice waits for the delay instead of sending right away", async () => {
    await runner.work(
      draftNoticeJob,
      handleDraftNotice({
        transport: { send: workerSend, close: () => {} },
        auth,
        publicUrl: "http://helpdesk.test",
        logger,
        noticeDelaySeconds: 2,
      }),
    );
    // Queued with the default 5-minute delay. The worker polls every 0.5 s, so an undelayed
    // job would have been sent well within this wait.
    const draft = await pendingDraft();
    await new Promise((r) => setTimeout(r, 3_000));
    expect(sentFor(draft.ticketId)).toEqual([]);
  });

  it("an older draft's job never emails about a draft that hasn't waited the full delay", async () => {
    const old = await pendingDraft();
    // Replaced just now: the new draft is younger than the delay and may still be approved.
    await db.withTenant(acme, async (tx) => {
      await tx
        .update(schema.drafts)
        .set({ status: "discarded" })
        .where(eq(schema.drafts.id, old.id));
      await tx.insert(schema.drafts).values({
        tenantId: acme,
        ticketId: old.ticketId,
        messageId: old.messageId,
        body: "Hand-written.",
      });
    });
    expect(await notify(old.id, 300)).not.toHaveBeenCalled();
  });

  it("a job that runs before its draft is old enough runs again later, and then notifies", async () => {
    const draft = await pendingDraft();
    // Too early for a 2 s delay: nothing now, and the job is queued again for when it's old enough.
    expect(await notify(draft.id, 2)).not.toHaveBeenCalled();
    const deadline = Date.now() + 15_000;
    while (sentFor(draft.ticketId).length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sentFor(draft.ticketId)).toHaveLength(1);
  });
});
