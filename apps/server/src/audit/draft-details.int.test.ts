import { createHash } from "node:crypto";
import {
  asc,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  schema,
  tenantTransactions,
  uuidv7,
} from "@helpos/db";
import { builtInActors } from "@helpos/db/actor";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Principal } from "../auth/principal.ts";
import { addMessage } from "../conversations/lifecycle.ts";
import {
  approveDraft,
  createReply,
  discardDraft,
  editDraft,
  markSendFailed,
  markSending,
  markSent,
  rejectSend,
  resolveUncertainSend,
  retrySend,
} from "../drafts/lifecycle.ts";
import { handleDraftNotice, handleNoticeGaveUp } from "../drafts/notice-worker.ts";
import { handleSendReply } from "../drafts/send-worker.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { SendRejected } from "../outbound-email/transport.ts";
import { composeServices } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import type { AuditContext } from "./audit.ts";

let testDb: TestDatabase;
let db: Database;
let runner: JobRunner;
let tenantId: string;
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const actor = { type: "user", id: uuidv7() } as const;
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const context = (): AuditContext => ({ tenantId, actor, requestId: "draft-details" });

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: logger.error });
  await runner.start();
  await ensureJobQueues(runner);
  const auth = createAuthStore(testDb.authUrl);
  try {
    const workspace = await initWorkspace(
      { db, auth },
      {
        workspace: "Audit details",
        mailbox: "details@audit.test",
        owner: "owner@audit.test",
      },
    );
    if (!workspace.ok) throw new Error("workspace setup failed");
    tenantId = workspace.tenantId;
  } finally {
    await auth.close();
  }
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await testDb?.stop();
});

async function fixture() {
  const result = await ingestEmail(
    { db, files },
    new TextEncoder().encode(
      [
        "From: customer@audit.test",
        "To: details@audit.test",
        `Message-ID: <${uuidv7()}@audit.test>`,
        `Subject: Audit ${uuidv7()}`,
        "",
        "Synthetic customer question",
      ].join("\r\n"),
    ),
  );
  if (result.kind !== "created") throw new Error(result.kind);
  const input = {
    tenantId,
    conversationId: result.conversationId,
    messageId: result.messageId,
    body: "Synthetic reply",
    noticeDelaySeconds: 3600,
  };
  const draft = await db.withTenant(tenantId, (tx) => createReply(tx, context(), input));
  return { ...input, draft };
}

const events = (id: string) =>
  db.withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, id))
      .orderBy(asc(schema.auditEvents.id)),
  );

async function prepared(f: Awaited<ReturnType<typeof fixture>>) {
  return db.withTenant(tenantId, async (tx) => {
    const [inbound] = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, f.messageId));
    if (!inbound) throw new Error("missing inbound");
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...values } = inbound;
    const messageId = uuidv7();
    await addMessage(tx, {
      ...values,
      id: messageId,
      direction: "outbound",
      messageIdHeader: `<${uuidv7()}@audit.test>`,
      sentAt: null,
    });
    expect((await markSending(tx, context(), f.draft.id, messageId)).outcome).toBe("changed");
    return messageId;
  });
}

it("records exact old/new and reviewed hashes through the public API; stale approval writes nothing", async () => {
  const f = await fixture();
  const principal: Principal = {
    tenantId,
    actor,
    scopes: new Set(["conversations:read", "drafts:write", "drafts:approve"]),
  };
  const app = createApp(composeServices({ db, files, logger }), {
    authenticate: async () => principal,
  });
  const call = (path: string, method: string, body: object, requestId: string) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(body),
    });
  const body = "Changed synthetic reply 🧪\r\nsecond line";
  expect((await call(`/v1/drafts/${f.draft.id}`, "PATCH", { body }, "edit-input")).status).toBe(
    200,
  );
  expect(
    (await call(`/v1/drafts/${f.draft.id}/approve`, "POST", { body: f.body }, "stale-input"))
      .status,
  ).toBe(409);
  expect(
    (await call(`/v1/drafts/${f.draft.id}/approve`, "POST", { body }, "approve-input")).status,
  ).toBe(200);
  const response = await app.request(`/v1/conversations/${f.conversationId}/drafts`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("approved");
  const rows = await events(f.draft.id);
  expect(rows.map((row) => [row.action, row.details])).toEqual([
    ["draft.created", { bodyHash: hash(f.body), messageId: f.messageId }],
    ["draft.edited", { oldBodyHash: hash(f.body), newBodyHash: hash(body) }],
    ["draft.approved", { reviewedBodyHash: hash(body) }],
  ]);
  expect(rows.map((row) => row.requestId)).toEqual([
    "draft-details",
    "edit-input",
    "approve-input",
  ]);
  for (const row of rows)
    expect(row).toMatchObject({
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      targetId: f.draft.id,
    });
  expect(JSON.stringify(rows)).not.toContain("synthetic reply");
});

it("distinguishes explicit regeneration, same-message replacement, manual discard and actual newer messages", async () => {
  const f = await fixture();
  const principal: Principal = {
    tenantId,
    actor,
    scopes: new Set(["conversations:read", "drafts:write"]),
  };
  const app = createApp(composeServices({ db, files, logger }), {
    authenticate: async () => principal,
  });
  const response = await app.request(`/v1/conversations/${f.conversationId}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ regenerate: true }),
  });
  expect(response.status).toBe(202);
  expect((await events(f.draft.id)).at(-1)?.details).toEqual({
    reason: "manual",
    operation: "regenerate",
  });
  const second = await db.withTenant(tenantId, (tx) => createReply(tx, context(), f));
  const third = await db.withTenant(tenantId, (tx) => createReply(tx, context(), f));
  expect((await events(second.id)).at(-1)?.details).toEqual({
    reason: "manual",
    operation: "replace",
  });
  const newerId = await db.withTenant(tenantId, async (tx) => {
    const [message] = await tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, f.messageId));
    if (!message) throw new Error("message missing");
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...values } = message;
    const id = uuidv7();
    await addMessage(tx, { ...values, id, messageIdHeader: `<${uuidv7()}@audit.test>` });
    return id;
  });
  const fourth = await db.withTenant(tenantId, (tx) =>
    createReply(tx, context(), { ...f, messageId: newerId }),
  );
  expect((await events(third.id)).at(-1)?.details).toEqual({
    reason: "superseded",
    newerMessageId: newerId,
  });
  await db.withTenant(tenantId, (tx) => discardDraft(tx, context(), fourth.id));
  expect((await events(fourth.id)).at(-1)?.details).toEqual({
    reason: "manual",
    operation: "discard",
  });
});

it("serializes concurrent edits so each recorded old hash is the preceding committed body", async () => {
  const f = await fixture();
  await Promise.all(
    ["A", "B"].map((body) =>
      db.withTenant(tenantId, (tx) => editDraft(tx, context(), f.draft.id, body)),
    ),
  );
  const rows = (await events(f.draft.id)).filter((row) => row.action === "draft.edited");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.details?.oldBodyHash).toBe(hash(f.body));
  expect(rows[1]?.details?.oldBodyHash).toBe(rows[0]?.details?.newBodyHash);
  const [draft] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.id, f.draft.id)),
  );
  expect(rows[1]?.details?.newBodyHash).toBe(hash(draft?.body ?? "missing"));
});

it("records failed retry, approved requeue, rejected sends, explicit resend and confirmed sends", async () => {
  const f = await fixture();
  await db.withTenant(tenantId, async (tx) => {
    await approveDraft(tx, context(), f.draft.id, f.body);
    await markSendFailed(tx, context(), f.draft.id);
    await retrySend(tx, context(), f.draft.id);
    await retrySend(tx, context(), f.draft.id);
  });
  await prepared(f);
  await db.withTenant(tenantId, (tx) => rejectSend(tx, context(), f.draft.id));
  const sentMessageId = await prepared(f);
  const [uncertain] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.id, f.draft.id)),
  );
  if (!uncertain?.outboundMessageIdHeader) throw new Error("uncertain draft missing");
  const resent = await db.withTenant(tenantId, (tx) =>
    resolveUncertainSend(tx, context(), f.draft.id, {
      messageId: uncertain.outboundMessageIdHeader ?? "",
      decision: "send_again",
    }),
  );
  if (resent.outcome !== "changed" || !resent.draft.outboundMessageIdHeader)
    throw new Error("resend failed");
  await db.withTenant(tenantId, (tx) =>
    resolveUncertainSend(tx, context(), f.draft.id, {
      messageId: resent.draft.outboundMessageIdHeader ?? "",
      decision: "mark_sent",
    }),
  );
  const rows = await events(f.draft.id);
  expect(
    rows.filter((row) => row.action === "draft.send_retried").map((row) => row.details),
  ).toEqual([
    { reason: "retry_failed" },
    { reason: "requeue_approved" },
    { reason: "resend_uncertain" },
  ]);
  expect(rows.filter((row) => row.action === "draft.sending").map((row) => row.details)).toEqual([
    { fromStatus: "approved", toStatus: "send_uncertain" },
    { fromStatus: "approved", toStatus: "send_uncertain" },
  ]);
  expect(rows.find((row) => row.action === "draft.send_rejected")?.details).toEqual({
    fromStatus: "send_uncertain",
    toStatus: "approved",
  });
  expect(rows.find((row) => row.action === "draft.send_failed")?.details).toEqual({
    fromStatus: "approved",
    toStatus: "send_failed",
  });
  expect(rows.at(-1)?.details).toEqual({ fromStatus: "send_uncertain", toStatus: "sent" });
  const [sentMessage] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.messages).where(eq(schema.messages.id, sentMessageId)),
  );
  expect(sentMessage?.sentAt).toBeInstanceOf(Date);
});

it("records normal sent and notice events with the draft actually being notified", async () => {
  const f = await fixture();
  const replacement = await db.withTenant(tenantId, (tx) => createReply(tx, context(), f));
  const notice = handleDraftNotice({
    transport: { send: async () => {}, close: async () => {} },
    auth: { emailsOf: async () => ["owner@audit.test"] },
    logger,
    config: { publicUrl: "http://audit.test", noticeDelaySeconds: 0 },
  });
  await db.withTenant(tenantId, (tx) => notice({ tenantId, draftId: f.draft.id }, tx));
  expect(
    (await events(f.conversationId)).find((row) => row.action === "draft.notice_sent")?.details,
  ).toEqual({ draftId: replacement.id });
  await db.withTenant(tenantId, (tx) =>
    handleNoticeGaveUp({ tenantId, draftId: replacement.id }, tx),
  );
  expect(
    (await events(f.conversationId)).find((row) => row.action === "draft.notice_failed")?.details,
  ).toEqual({ draftId: replacement.id });
  await db.withTenant(tenantId, (tx) => approveDraft(tx, context(), replacement.id, f.body));
  const sentMessageId = await prepared({ ...f, draft: replacement });
  await db.withTenant(tenantId, (tx) =>
    markSent(tx, context(), replacement.id, { sentAt: new Date(), sentMessageId }),
  );
  expect((await events(replacement.id)).at(-1)).toMatchObject({
    action: "draft.sent",
    details: { fromStatus: "send_uncertain", toStatus: "sent" },
  });
});

it("records a rejected explicit resend as still uncertain rather than approved", async () => {
  const f = await fixture();
  await db.withTenant(tenantId, (tx) => approveDraft(tx, context(), f.draft.id, f.body));
  await prepared(f);
  const [uncertain] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.id, f.draft.id)),
  );
  if (!uncertain?.outboundMessageIdHeader) throw new Error("uncertain draft missing");
  await db.withTenant(tenantId, (tx) =>
    resolveUncertainSend(tx, context(), f.draft.id, {
      messageId: uncertain.outboundMessageIdHeader ?? "",
      decision: "send_again",
    }),
  );
  const worker = handleSendReply({
    files,
    logger,
    transport: {
      send: async () => {
        throw new SendRejected("synthetic rejection");
      },
      close: () => {},
    },
  });
  await expect(
    worker({ tenantId, draftId: f.draft.id }, tenantTransactions(db, tenantId)),
  ).rejects.toBeInstanceOf(SendRejected);
  const rows = await events(f.draft.id);
  expect(rows.at(-1)).toMatchObject({
    action: "draft.send_rejected",
    actorId: builtInActors.sendWorker.id,
    requestId: null,
    details: { fromStatus: "send_uncertain", toStatus: "send_uncertain" },
  });
  expect(rows.filter((row) => row.action === "draft.sending").at(-1)?.details).toEqual({
    fromStatus: "send_uncertain",
    toStatus: "send_uncertain",
  });
  const [draft] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.id, f.draft.id)),
  );
  expect(draft?.status).toBe("send_uncertain");
});
