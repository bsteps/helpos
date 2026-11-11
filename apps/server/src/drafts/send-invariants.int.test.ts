import { mockModel } from "@helpos/ai/testing";
import { createAuthStore, createDatabase, type Database, eq, schema } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { auditorFor } from "../audit/audit.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { SendRejected } from "../outbound-email/transport.ts";
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
        throw new SendRejected("SMTP unavailable");
      },
      close: () => {},
    },
  });
  await server.runner.work(sendReplyJob, {
    steps: send,
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
  await send(payload, (fn) => db.withTenant(tenantId, fn));
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
    await send(payload, (fn) => db.withTenant(tenantId, fn));
    const attempts = await Promise.allSettled([send(payload, (fn) => db.withTenant(tenantId, fn))]);
    if (property === "NoResendWithoutPerson") expect(acceptedWhile.length).toBe(1);
    else expect(acceptedWhile.every((s) => s === "send_uncertain")).toBe(true);
    expect(attempts[0]?.status).toBe("fulfilled");
  });
}

async function decision(
  payload: { draftId: string },
  input: { messageId: string; decision: "mark_sent" | "send_again" },
  actor: "user" | "agent" = "user",
  workspace = tenantId,
) {
  const app = createApp(server.services, {
    authenticate: async () => ({
      tenantId: workspace,
      actor: { type: actor, id: "test-human" },
      scopes: new Set(["drafts:approve"] as const),
    }),
  });
  return app.request(`/v1/drafts/${payload.draftId}/resolve-send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function readDraft(id: string) {
  const [draft] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.id, id)),
  );
  if (!draft?.outboundMessageIdHeader) throw new Error("missing approved draft");
  return { ...draft, outboundMessageIdHeader: draft.outboundMessageIdHeader };
}

it("UncertainGuard: a lost SMTP reply is never retried automatically", async () => {
  const payload = await approved();
  const sendMail = vi.fn(async () => {
    throw new Error("SMTP reply lost after acceptance");
  });
  const send = handleSendReply({ files, logger, transport: { send: sendMail, close: () => {} } });
  await expect(send(payload, (fn) => db.withTenant(tenantId, fn))).rejects.toThrow(
    "SMTP reply lost",
  );
  await send(payload, (fn) => db.withTenant(tenantId, fn));
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(await status(payload.draftId)).toBe("send_uncertain");
});

it("uncertain decisions require a scoped human in the same tenant and the exact attempt", async () => {
  const payload = await approved();
  const sendMail = vi.fn(async () => {
    throw new Error("lost reply");
  });
  const send = handleSendReply({ files, logger, transport: { send: sendMail, close: () => {} } });
  await expect(send(payload, (fn) => db.withTenant(tenantId, fn))).rejects.toThrow();
  const draft = await readDraft(payload.draftId);
  const input = { messageId: draft.outboundMessageIdHeader, decision: "mark_sent" as const };
  expect((await decision(payload, input, "agent")).status).toBe(403);
  expect(
    (await decision(payload, input, "user", "0190d6a4-0000-7000-8000-000000000001")).status,
  ).toBe(404);
  expect((await decision(payload, { ...input, messageId: "<stale@example.test>" })).status).toBe(
    409,
  );
  expect((await decision(payload, input)).status).toBe(200);
  expect((await decision(payload, input)).status).toBe(409);
  await send(payload, (fn) => db.withTenant(tenantId, fn));
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(await status(payload.draftId)).toBe("sent");
});

it("a human can authorize one resend without hiding the original uncertainty on rejection", async () => {
  const payload = await approved();
  const sendMail = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("lost reply"))
    .mockRejectedValue(new SendRejected("refused"));
  const send = handleSendReply({ files, logger, transport: { send: sendMail, close: () => {} } });
  await expect(send(payload, (fn) => db.withTenant(tenantId, fn))).rejects.toThrow();
  const draft = await readDraft(payload.draftId);
  const input = { messageId: draft.outboundMessageIdHeader, decision: "send_again" as const };
  expect((await decision(payload, input)).status).toBe(200);
  expect((await decision(payload, input)).status).toBe(409);
  await expect(send(payload, (fn) => db.withTenant(tenantId, fn))).rejects.toThrow("refused");
  await send(payload, (fn) => db.withTenant(tenantId, fn));
  expect(sendMail).toHaveBeenCalledTimes(2);
  expect(await status(payload.draftId)).toBe("send_uncertain");
});

it("MarkerGuard: a human decision between marker commit and SMTP cancels that worker", async () => {
  const payload = await approved();
  const sendMail = vi.fn(async () => {});
  const send = handleSendReply({ files, logger, transport: { send: sendMail, close: () => {} } });
  let first = true;
  await Promise.allSettled([
    send(payload, async (fn) => {
      const result = await db.withTenant(tenantId, fn);
      if (first) {
        first = false;
        const draft = await readDraft(payload.draftId);
        expect(
          (
            await decision(payload, {
              messageId: draft.outboundMessageIdHeader,
              decision: "mark_sent",
            })
          ).status,
        ).toBe(200);
      }
      return result;
    }),
  ]);
  expect(sendMail).not.toHaveBeenCalled();
});
