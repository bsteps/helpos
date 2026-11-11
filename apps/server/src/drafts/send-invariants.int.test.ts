import { mockModel } from "@helpos/ai/testing";
import { createAuthStore, createDatabase, type Database, eq, schema } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { auditorFor } from "../audit/audit.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServer, type Server } from "../server.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { sendReplyJob } from "./jobs.ts";
import { approveDraft, createReply } from "./lifecycle.ts";
import { handleSendGaveUp, handleSendReply } from "./send-worker.ts";

let testDb: TestDatabase;
let db: Database;
let server: Server;
let auth: ReturnType<typeof createAuthStore>;
let tenantId: string;
let sequence = 0;
const files = createMemoryFileStore();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  server = composeServer({
    db,
    auth,
    jobsUrl: testDb.jobsUrl,
    files,
    logger,
    model: mockModel({ text: "Reply" }),
    config: { publicUrl: "http://helpdesk.test" },
  });
  await server.runner.start();
  await ensureJobQueues(server.runner, { jobRetry: { limit: 0, delaySeconds: 0, backoff: false } });
  const workspace = await initWorkspace(
    { db, auth },
    {
      workspace: "Invariant replay",
      mailbox: "support@invariant.test",
      owner: "owner@invariant.test",
    },
  );
  if (!workspace.ok) throw new Error("workspace setup failed");
  tenantId = workspace.tenantId;
  await db.withTenant(tenantId, (tx) =>
    tx.update(schema.tenants).set({ shadowMode: false }).where(eq(schema.tenants.id, tenantId)),
  );
}, 180_000);

afterAll(async () => {
  await server?.runner.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

async function approved() {
  const received = await ingestEmail(
    { db, files },
    new TextEncoder().encode(
      [
        "From: customer@invariant.test",
        "To: support@invariant.test",
        `Message-ID: <invariant-${++sequence}@invariant.test>`,
        "Subject: Question",
        "",
        "Hello",
      ].join("\r\n"),
    ),
  );
  if (received.kind !== "created") throw new Error(received.kind);
  return db.withTenant(tenantId, async (tx) => {
    const audit = auditorFor(tenantId, { type: "system", id: "invariant-test" });
    const draft = await createReply(tx, audit, {
      tenantId,
      conversationId: received.conversationId,
      messageId: received.messageId,
      body: "Reply",
      noticeDelaySeconds: 3600,
    });
    const result = await approveDraft(tx, audit, draft.id, draft.body);
    expect(result.outcome).toBe("changed");
    return { tenantId, draftId: draft.id };
  });
}

async function status(draftId: string) {
  const rows = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.id, draftId)),
  );
  return rows[0]?.status;
}

it("NoSilentStall: terminal give-up leaves visible failure", async () => {
  const payload = await approved();
  const gaveUp = Promise.withResolvers<void>();
  const send = handleSendReply({
    files,
    logger,
    transport: {
      send: async () => {
        throw new Error("SMTP unavailable");
      },
      close: () => {},
    },
  });
  await server.runner.work(sendReplyJob, {
    transaction: send,
    onGiveUp: async (job, tx) => {
      await handleSendGaveUp(job, tx);
      gaveUp.resolve();
    },
  });
  await gaveUp.promise;
  await server.runner.stop();
  expect(await status(payload.draftId)).toBe("send_failed");
});

it("NoHiddenDelivery: late give-up preserves sent", async () => {
  const payload = await approved();
  const send = handleSendReply({
    files,
    logger,
    transport: { send: async () => {}, close: () => {} },
  });
  await db.withTenant(tenantId, (tx) => send(payload, tx));
  await db.withTenant(tenantId, (tx) => handleSendGaveUp(payload, tx));
  expect(await status(payload.draftId)).toBe("sent");
});

for (const property of ["NoResendWithoutPerson", "SentOnlyWhenApproved"]) {
  it(`${property}: repeated worker invocation does not redeliver`, async () => {
    const payload = await approved();
    const acceptedWhile: (string | undefined)[] = [];
    const send = handleSendReply({
      files,
      logger,
      transport: {
        send: async () => {
          acceptedWhile.push(await status(payload.draftId));
        },
        close: () => {},
      },
    });
    await db.withTenant(tenantId, (tx) => send(payload, tx));
    const attempts = await Promise.allSettled([db.withTenant(tenantId, (tx) => send(payload, tx))]);
    if (property === "NoResendWithoutPerson") expect(acceptedWhile.length).toBe(1);
    else expect(acceptedWhile.every((s) => s === "approved")).toBe(true);
    expect(attempts[0]?.status).toBe("fulfilled");
  });
}
