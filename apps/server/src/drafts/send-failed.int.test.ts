import { mockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  asc,
  createAuthStore,
  createDatabase,
  type Database,
  eq,
  type JobRunner,
  schema,
} from "@helpos/db";
import {
  containerHost,
  startTestDatabase,
  type TestDatabase,
  waitFor,
  waitForTenantJobs,
} from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { createSmtpTransport, type EmailTransport } from "../outbound-email/transport.ts";
import { composeServer, type Server } from "../server.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { sendReplyJob } from "./jobs.ts";

// A send that fails for good: every attempt fails, the draft becomes `send_failed` with an
// audit event, and a person or agent retries it (same Message-ID, sent once, shadow mode as it
// is at send time) or discards it. Real Postgres, pg-boss and SMTP (Mailpit), with a switch in
// front of the SMTP transport to take it "down".

const draftText = "Hi, thanks for writing. We'll look into it today.";
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let mailpit: StartedTestContainer;
let mailpitApi: string;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
/** The API and the worker, built from one set of services as in the real server. */
let helpos: Server;
let smtp: EmailTransport;
let acme: string;
let other: string;
/** While true, every send attempt fails, as when the mail server is down. */
let smtpDown = false;
let sendAttempts = 0;

const principals: Record<string, () => Principal> = {
  approver: () => principal(acme, ["conversations:read", "drafts:write", "drafts:approve"]),
  drafter: () => principal(acme, ["conversations:read", "drafts:write"]),
  outsider: () => principal(other, ["conversations:read", "drafts:write", "drafts:approve"]),
};
function principal(tenantId: string, scopes: Scope[]): Principal {
  return { tenantId, actor: { type: "agent", id: "test-agent" }, scopes: new Set(scopes) };
}

const app = () =>
  createApp(helpos.services, {
    authenticate: async (req) => {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return principals[token]?.() ?? null;
    },
  });

function call(method: string, path: string, as: string, body?: object) {
  return app().request(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

let emailCount = 0;
async function receiveEmail() {
  emailCount++;
  const subject = `Order missing ${emailCount}`;
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    "To: support@acme.test",
    `Subject: ${subject}`,
    `Message-ID: <order-${emailCount}@customer.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi, my order hasn't arrived.",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return { conversationId: result.conversationId, subject };
}

const draftsOf = (conversationId: string) =>
  db.withTenant(acme, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, conversationId)),
  );
const waitForDraft = (conversationId: string, status: string) =>
  waitFor(`draft ${status}`, async () =>
    (await draftsOf(conversationId)).find((d) => d.status === status),
  );
const auditOf = async (draftId: string) =>
  (
    await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, draftId))
        .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id)),
    )
  ).map((e) => [e.action, e.actorType]);

type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] };
async function mailFor(subject: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitApi}/api/v1/messages`);
  const { messages } = (await res.json()) as { messages: MailpitMessage[] };
  return messages.filter((m) => m.Subject === `Re: ${subject}`);
}

/** A conversation whose approved reply failed every attempt, while SMTP was down. */
async function failedDraft() {
  const email = await receiveEmail();
  const pending = await waitForDraft(email.conversationId, "pending");
  smtpDown = true;
  const approve = await call("POST", `/v1/drafts/${pending.id}/approve`, "approver", {
    body: pending.body,
  });
  expect(approve.status).toBe(200);
  const failed = await waitForDraft(email.conversationId, "send_failed");
  await waitForTenantJobs(testDb, acme, { queues: [sendReplyJob.queue] });
  smtpDown = false;
  return { ...email, draft: failed };
}

beforeAll(async () => {
  [testDb, mailpit] = await Promise.all([
    startTestDatabase(),
    new GenericContainer("axllent/mailpit:v1.27").withExposedPorts(1025, 8025).start(),
  ]);
  mailpitApi = `http://${containerHost(mailpit)}:${mailpit.getMappedPort(8025)}`;
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  smtp = createSmtpTransport(`smtp://${containerHost(mailpit)}:${mailpit.getMappedPort(1025)}`);
  helpos = composeServer({
    db,
    jobsUrl: testDb.jobsUrl,
    pollingIntervalSeconds: 0.5,
    onJobError: (error) => {
      throw error;
    },
    files,
    logger,
    model: mockModel({ text: draftText }),
    transport: {
      send: async (message) => {
        sendAttempts++;
        if (smtpDown) throw new Error("SMTP down");
        await smtp.send(message);
      },
      close: () => {},
    },
    auth,
    config: {
      publicUrl: "http://helpdesk.test",
      noticeDelaySeconds: 3600,
      dailyTokenBudget: 1_000_000,
      // Two attempts a second apart, so giving up takes seconds, not hours.
      jobRetry: { limit: 1, delaySeconds: 1, backoff: false },
    },
  });
  runner = helpos.runner;
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
  // Shadow mode off, so the retry tests can check delivery to the customer (and that turning
  // it on before a retry wins).
  await setShadowMode(false);
});

afterAll(async () => {
  await runner?.stop();
  smtp?.close();
  await db?.close();
  await auth?.close();
  await Promise.all([testDb?.stop(), mailpit?.stop()]);
});

function setShadowMode(on: boolean) {
  return db.withTenant(acme, (tx) =>
    tx
      .update(schema.tenants)
      .set({ shadowMode: on, shadowRecipient: on ? "owner@acme.test" : null })
      .where(eq(schema.tenants.id, acme)),
  );
}

describe("a send that fails for good", () => {
  it("becomes send_failed with an audit event, visible in the drafts list, and nothing is stored as sent", async () => {
    const before = sendAttempts;
    const { conversationId, draft } = await failedDraft();
    // The first attempt and its one retry.
    expect(sendAttempts - before).toBe(2);
    expect(await auditOf(draft.id)).toEqual([
      ["draft.created", "system"],
      ["draft.approved", "agent"],
      ["draft.send_failed", "system"],
    ]);

    const list = await call("GET", `/v1/conversations/${conversationId}/drafts`, "drafter");
    expect(await list.json()).toMatchObject({
      drafts: [{ id: draft.id, status: "send_failed", sentAt: null }],
    });
    const outbound = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.direction, "outbound")),
    );
    expect(outbound.filter((m) => m.conversationId === conversationId)).toEqual([]);
    // Approve and edit still refuse it: retry and discard are the ways out.
    expect(
      (await call("POST", `/v1/drafts/${draft.id}/approve`, "approver", { body: draft.body }))
        .status,
    ).toBe(409);
    expect((await call("PATCH", `/v1/drafts/${draft.id}`, "drafter", { body: "x" })).status).toBe(
      409,
    );
  });

  it("retry sends it once, with the same Message-ID, however often it is asked", async () => {
    const { conversationId, subject, draft } = await failedDraft();

    // Retrying is approving: it needs drafts:approve, and another workspace can't see it.
    expect((await call("POST", `/v1/drafts/${draft.id}/retry`, "drafter")).status).toBe(403);
    expect((await call("POST", `/v1/drafts/${draft.id}/retry`, "outsider")).status).toBe(404);

    // Two at once, then one more: only one send is queued between them.
    const [first, second] = await Promise.all([
      call("POST", `/v1/drafts/${draft.id}/retry`, "approver"),
      call("POST", `/v1/drafts/${draft.id}/retry`, "approver"),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.json()).toMatchObject({ id: draft.id, status: expect.any(String) });

    const sent = await waitForDraft(conversationId, "sent");
    const again = await call("POST", `/v1/drafts/${draft.id}/retry`, "approver");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ status: "sent" });
    expect(sent.outboundMessageIdHeader).toBe(draft.outboundMessageIdHeader);

    const mail = await waitFor("the reply in Mailpit", async () => (await mailFor(subject))[0]);
    await waitForTenantJobs(testDb, acme, { queues: [sendReplyJob.queue] });
    expect(await mailFor(subject)).toHaveLength(1);
    expect(mail.To.map((t) => t.Address)).toEqual(["jane@customer.test"]);
    const headers = (await (
      await fetch(`${mailpitApi}/api/v1/message/${mail.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["Message-Id"]?.[0] ?? headers["Message-ID"]?.[0]).toBe(
      draft.outboundMessageIdHeader,
    );

    // Both concurrent requests are logged (the second one found it approved already); the
    // later one, after it was sent, changed nothing and logs nothing.
    expect(await auditOf(draft.id)).toEqual([
      ["draft.created", "system"],
      ["draft.approved", "agent"],
      ["draft.send_failed", "system"],
      ["draft.send_retried", "agent"],
      ["draft.send_retried", "agent"],
      ["draft.sent", "system"],
    ]);
  });

  it("a retry respects shadow mode as it is when the reply is sent", async () => {
    const { conversationId, subject, draft } = await failedDraft();
    // Shadow mode was off when it was approved; it's on now.
    await setShadowMode(true);
    try {
      expect((await call("POST", `/v1/drafts/${draft.id}/retry`, "approver")).status).toBe(200);
      await waitForDraft(conversationId, "sent");
      const [mail] = await waitFor("the shadowed reply", async () => {
        const found = await mailFor(subject);
        return found.length > 0 ? found : undefined;
      });
      expect(mail?.To.map((t) => t.Address)).toEqual(["owner@acme.test"]);
      expect(await mailFor(subject)).toHaveLength(1);
    } finally {
      await setShadowMode(false);
    }
  });

  it("discard takes it out for good: never retried, never sent", async () => {
    const { conversationId, subject, draft } = await failedDraft();
    expect((await call("POST", `/v1/drafts/${draft.id}/discard`, "outsider")).status).toBe(404);
    const discard = await call("POST", `/v1/drafts/${draft.id}/discard`, "drafter");
    expect(discard.status).toBe(200);
    expect(await discard.json()).toMatchObject({ status: "discarded" });

    const retry = await call("POST", `/v1/drafts/${draft.id}/retry`, "approver");
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "not_send_failed" });
    expect((await draftsOf(conversationId))[0]?.status).toBe("discarded");
    expect(await mailFor(subject)).toEqual([]);
    expect(await auditOf(draft.id)).toEqual([
      ["draft.created", "system"],
      ["draft.approved", "agent"],
      ["draft.send_failed", "system"],
      ["draft.discarded", "agent"],
    ]);

    // With it gone, the conversation can be answered again.
    const fresh = await call("POST", `/v1/conversations/${conversationId}/drafts`, "drafter", {
      body: "Let me try that again.",
    });
    expect(fresh.status).toBe(201);
  });

  it("a draft that was never approved can't be retried", async () => {
    const { conversationId } = await receiveEmail();
    const pending = await waitForDraft(conversationId, "pending");
    const retry = await call("POST", `/v1/drafts/${pending.id}/retry`, "approver");
    expect(retry.status).toBe(409);
    expect((await draftsOf(conversationId))[0]?.status).toBe("pending");
  });

  it("the retry route is in the OpenAPI spec", async () => {
    const spec = (await (await app().request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(spec.paths["/v1/drafts/{id}/retry"] ?? {})).toEqual(["post"]);
  });
  it("retry recovers an approved draft whose send job was lost, and still sends it once", async () => {
    const { conversationId, subject } = await receiveEmail();
    const pending = await waitForDraft(conversationId, "pending");
    // Approved with no job behind it, as when the last attempt expired before giving up.
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.drafts)
        .set({ status: "approved", outboundMessageIdHeader: `<lost-${pending.id}@acme.test>` })
        .where(eq(schema.drafts.id, pending.id)),
    );
    const retries = await Promise.all([
      call("POST", `/v1/drafts/${pending.id}/retry`, "approver"),
      call("POST", `/v1/drafts/${pending.id}/retry`, "approver"),
    ]);
    expect(retries.map((r) => r.status)).toEqual([200, 200]);
    await waitForDraft(conversationId, "sent");
    await waitFor("the reply in Mailpit", async () => (await mailFor(subject))[0]);
    await waitForTenantJobs(testDb, acme, { queues: [sendReplyJob.queue] });
    expect(await mailFor(subject)).toHaveLength(1);
    // Each recovery request is on the audit log, with who asked.
    const retried = (await auditOf(pending.id)).filter(([a]) => a === "draft.send_retried");
    expect(retried).toEqual([
      ["draft.send_retried", "agent"],
      ["draft.send_retried", "agent"],
    ]);
  });
});
