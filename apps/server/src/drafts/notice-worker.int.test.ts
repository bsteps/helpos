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
import { handleDraftNotice } from "./notice-worker.ts";

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

function notify(draftId: string) {
  const send = vi.fn<EmailTransport["send"]>();
  const run = db.withTenant(acme, (tx) =>
    handleDraftNotice({
      transport: { send, close: () => {} },
      auth,
      publicUrl: "http://helpdesk.test",
      logger,
    })({ tenantId: acme, draftId }, tx),
  );
  return run.then(() => send);
}

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
    // A hand-written draft replaces it, and its own enqueue was deduped into the queued job.
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
});
