import { mockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  asc,
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
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { createSmtpTransport, type EmailTransport } from "../outbound-email/transport.ts";
import { startWorker } from "../worker.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { handleSendReply } from "./send-worker.ts";

// The whole loop against real Postgres, real pg-boss and a real SMTP server (Mailpit):
// email in → AI draft (mock model) → edit → approve → threaded reply arrives.

const draftText = "Hi Jane, sorry about that. A teammate will look into it and follow up.";
const model = mockModel({ text: draftText });
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let mailpit: StartedTestContainer;
let mailpitApi: string;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let transport: EmailTransport;
let acme: string;
let other: string;

/** Test credentials: the bearer value names a principal. Real tokens come with #49. */
const principals: Record<string, () => Principal> = {
  approver: () => principal(acme, ["tickets:read", "drafts:write", "drafts:approve"]),
  drafter: () => principal(acme, ["tickets:read", "drafts:write"]),
  outsider: () => principal(other, ["tickets:read", "drafts:write", "drafts:approve"]),
};
function principal(tenantId: string, scopes: Scope[]): Principal {
  return { tenantId, actor: { type: "agent", id: "test-agent" }, scopes: new Set(scopes) };
}

const app = () =>
  createApp({
    db,
    files,
    logger,
    inboundSecret: undefined,
    authenticate: async (req) => {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return principals[token]?.() ?? null;
    },
  });

function call(method: string, path: string, as: string | null, body?: object) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${as}`;
  return app().request(path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

let emailCount = 0;
/** A fresh customer email to Acme, with a unique Message-ID and subject. */
async function receiveEmail(
  body = "Hi, I cannot log in since this morning.",
  options: { replyTo?: string; html?: boolean } = {},
) {
  emailCount++;
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    "To: support@acme.test",
    `Subject: Cannot log in ${emailCount}`,
    `Message-ID: <login-${emailCount}@customer.test>`,
    ...(options.replyTo
      ? [`In-Reply-To: ${options.replyTo}`, `References: ${options.replyTo}`]
      : ["References: <earlier@customer.test>"]),
    `Content-Type: text/${options.html ? "html" : "plain"}; charset=utf-8`,
    "",
    body,
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return {
    ...result,
    subject: `Cannot log in ${emailCount}`,
    header: `<login-${emailCount}@customer.test>`,
  };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const draftsOf = (ticketId: string) =>
  db.withTenant(acme, (tx) =>
    tx.select().from(schema.drafts).where(eq(schema.drafts.ticketId, ticketId)),
  );
const waitForDraft = (ticketId: string, status: string) =>
  waitFor(`draft ${status}`, async () =>
    (await draftsOf(ticketId)).find((d) => d.status === status),
  );
const auditOf = (draftId: string) =>
  db.withTenant(acme, (tx) =>
    tx
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, draftId))
      .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id)),
  );

type MailpitMessage = {
  ID: string;
  Subject: string;
  From: { Address: string };
  To: { Address: string }[];
};
async function mailpitMessages(): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitApi}/api/v1/messages`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

beforeAll(async () => {
  [testDb, mailpit] = await Promise.all([
    startTestDatabase(),
    new GenericContainer("axllent/mailpit:v1.27").withExposedPorts(1025, 8025).start(),
  ]);
  mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  transport = createSmtpTransport(`smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`);
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: (error) => {
      throw error;
    },
    pollingIntervalSeconds: 0.5,
  });
  await runner.start();
  await startWorker({ runner, files, logger, model, transport });

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
  await runner?.stop();
  transport?.close();
  await db?.close();
  await auth?.close();
  await Promise.all([testDb?.container.stop(), mailpit?.stop()]);
});

describe("draft → approve → send", () => {
  it("drafts a reply, and sends it threaded only after approval", async () => {
    const email = await receiveEmail();
    expect(email.draftReply).toBe(true);

    // The worker drafts it with the model. The customer's text reaches it only as quoted data.
    const pending = await waitForDraft(email.ticketId, "pending");
    expect(pending.body).toBe(draftText);
    const prompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
    expect(prompt).toMatch(/<untrusted_email>.*I cannot log in.*<\/untrusted_email>/);

    // Pending means unsent.
    expect((await mailpitMessages()).some((m) => m.Subject.includes(email.subject))).toBe(false);

    const list = await call("GET", `/v1/tickets/${email.ticketId}/drafts`, "drafter");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ drafts: [{ id: pending.id, status: "pending" }] });

    const edited = "Hi Jane, we reset your session. Please try again.";
    const edit = await call("PATCH", `/v1/drafts/${pending.id}`, "drafter", { body: edited });
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ body: edited, status: "pending" });

    // Drafting doesn't imply approving: that scope is separate.
    expect(
      (await call("POST", `/v1/drafts/${pending.id}/approve`, "drafter", { body: edited })).status,
    ).toBe(403);

    // Approving text other than the current body (e.g. edited after review) approves nothing.
    expect(
      (await call("POST", `/v1/drafts/${pending.id}/approve`, "approver", { body: draftText }))
        .status,
    ).toBe(409);

    const approve = await call("POST", `/v1/drafts/${pending.id}/approve`, "approver", {
      body: edited,
    });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({ status: "approved" });
    const requestId = approve.headers.get("x-request-id");
    expect(requestId).toBeTruthy();

    // Approved is final: no second approval, no edits.
    expect(
      (await call("POST", `/v1/drafts/${pending.id}/approve`, "approver", { body: edited })).status,
    ).toBe(409);
    expect(
      (await call("PATCH", `/v1/drafts/${pending.id}`, "drafter", { body: "changed" })).status,
    ).toBe(409);

    const sent = await waitForDraft(email.ticketId, "sent");
    expect(sent.sentAt).not.toBeNull();

    // It arrived, threaded onto the customer's email.
    const mail = await waitFor("mail in Mailpit", async () =>
      (await mailpitMessages()).find((m) => m.Subject === `Re: ${email.subject}`),
    );
    expect(mail.From.Address).toBe("support@acme.test");
    expect(mail.To.map((t) => t.Address)).toEqual(["jane@customer.test"]);
    const headers = (await (
      await fetch(`${mailpitApi}/api/v1/message/${mail.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["In-Reply-To"]).toEqual([email.header]);
    expect(headers.References?.[0]).toBe(`<earlier@customer.test> ${email.header}`);
    expect(headers["Message-Id"]?.[0] ?? headers["Message-ID"]?.[0]).toBe(
      sent.outboundMessageIdHeader,
    );
    const text = (await (await fetch(`${mailpitApi}/api/v1/message/${mail.ID}`)).json()) as {
      Text: string;
    };
    expect(text.Text.trim()).toBe(edited);

    // The reply is on the ticket as an outbound message.
    const [outbound] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, sent.sentMessageId ?? "")),
    );
    expect(outbound).toMatchObject({ direction: "outbound", ticketId: email.ticketId });

    // Every step is in the audit log, with who did it.
    const audit = await auditOf(pending.id);
    expect(audit.map((e) => [e.action, e.actorType, e.actorId])).toEqual([
      ["draft.created", "system", "draft-reply"],
      ["draft.edited", "agent", "test-agent"],
      ["draft.approved", "agent", "test-agent"],
      ["draft.sent", "system", "send-reply"],
    ]);
    expect(audit[2]?.requestId).toBe(requestId);
  });
});

describe("nothing is sent without approval", () => {
  it("the send worker refuses a pending draft, even if a send job is forced", async () => {
    const email = await receiveEmail();
    const pending = await waitForDraft(email.ticketId, "pending");
    const send = vi.fn<EmailTransport["send"]>();
    await db.withTenant(acme, (tx) =>
      handleSendReply({ transport: { send, close: () => {} }, files, logger })(
        { tenantId: acme, draftId: pending.id },
        tx,
      ),
    );
    expect(send).not.toHaveBeenCalled();
    expect((await draftsOf(email.ticketId))[0]?.status).toBe("pending");
  });

  it("a failed send keeps the draft approved and writes nothing, so a retry can send it", async () => {
    const email = await receiveEmail();
    const pending = await waitForDraft(email.ticketId, "pending");
    // Approve directly, so the running worker doesn't race this test for the job.
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.drafts)
        .set({ status: "approved", outboundMessageIdHeader: "<retry@acme.test>" })
        .where(eq(schema.drafts.id, pending.id)),
    );
    const failing: EmailTransport = {
      send: async () => {
        throw new Error("SMTP down");
      },
      close: () => {},
    };
    await expect(
      db.withTenant(acme, (tx) =>
        handleSendReply({ transport: failing, files, logger })(
          { tenantId: acme, draftId: pending.id },
          tx,
        ),
      ),
    ).rejects.toThrow("SMTP down");

    expect((await draftsOf(email.ticketId))[0]?.status).toBe("approved");
    expect((await auditOf(pending.id)).map((e) => e.action)).toEqual(["draft.created"]);
    const outbound = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.messageIdHeader, "<retry@acme.test>")),
    );
    expect(outbound).toEqual([]);
  });
});

describe("drafting in context", () => {
  it("a follow-up is drafted with the earlier messages, and discards the stale pending draft", async () => {
    const first = await receiveEmail("My invoice for March is missing.");
    const stale = await waitForDraft(first.ticketId, "pending");
    const followUp = await receiveEmail("Also, the April one has the wrong VAT number.", {
      replyTo: first.header,
    });
    expect(followUp.ticketId).toBe(first.ticketId);

    const fresh = await waitFor("a second draft", async () =>
      (await draftsOf(first.ticketId)).find((d) => d.id !== stale.id && d.status === "pending"),
    );
    expect(fresh.messageId).toBe(followUp.messageId);
    const old = (await draftsOf(first.ticketId)).find((d) => d.id === stale.id);
    expect(old?.status).toBe("discarded");
    expect((await auditOf(stale.id)).map((e) => [e.action, e.actorId])).toEqual([
      ["draft.created", "draft-reply"],
      ["draft.discarded", "draft-reply"],
    ]);

    const prompt = JSON.stringify(
      model.doGenerateCalls.find((c) => JSON.stringify(c.prompt).includes("wrong VAT"))?.prompt,
    );
    // Both messages, inside the one fence, earlier one first.
    expect(prompt).toMatch(/<untrusted_email>.*invoice for March.*wrong VAT.*<\/untrusted_email>/);
  });

  it("an HTML-only email is drafted from its text, not from nothing", async () => {
    const email = await receiveEmail("<p>My <b>export</b> button&nbsp;is greyed out.</p>", {
      html: true,
    });
    await waitForDraft(email.ticketId, "pending");
    const prompt = JSON.stringify(
      model.doGenerateCalls.find((c) => JSON.stringify(c.prompt).includes("greyed out"))?.prompt,
    );
    expect(prompt).toContain("My export button is greyed out.");
  });
});

describe("discarding", () => {
  it("a discarded draft can never be approved or sent", async () => {
    const email = await receiveEmail();
    const pending = await waitForDraft(email.ticketId, "pending");
    const res = await call("POST", `/v1/drafts/${pending.id}/discard`, "drafter");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "discarded" });

    expect((await call("POST", `/v1/drafts/${pending.id}/discard`, "drafter")).status).toBe(409);
    expect(
      (await call("POST", `/v1/drafts/${pending.id}/approve`, "approver", { body: pending.body }))
        .status,
    ).toBe(409);
    expect((await call("POST", `/v1/drafts/${pending.id}/discard`, "outsider")).status).toBe(404);
    expect((await auditOf(pending.id)).map((e) => [e.action, e.actorType])).toEqual([
      ["draft.created", "system"],
      ["draft.discarded", "agent"],
    ]);
  });
});

describe("POST /v1/tickets/{id}/drafts", () => {
  const live = async (ticketId: string) =>
    (await draftsOf(ticketId)).filter((d) => d.status !== "discarded");

  it("saves a hand-written draft and discards the AI one it replaces", async () => {
    const email = await receiveEmail();
    const ai = await waitForDraft(email.ticketId, "pending");
    const res = await call("POST", `/v1/tickets/${email.ticketId}/drafts`, "drafter", {
      body: "Hi Jane, I've reset your account myself.",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; status: string; messageId: string };
    expect(created).toMatchObject({ status: "pending", messageId: email.messageId });

    expect((await live(email.ticketId)).map((d) => d.id)).toEqual([created.id]);
    expect((await auditOf(ai.id)).map((e) => [e.action, e.actorType])).toEqual([
      ["draft.created", "system"],
      ["draft.discarded", "agent"],
    ]);
    expect((await auditOf(created.id)).map((e) => [e.action, e.actorId])).toEqual([
      ["draft.created", "test-agent"],
    ]);
  });

  it("regenerate queues a fresh AI draft after the last one was discarded", async () => {
    const email = await receiveEmail();
    const first = await waitForDraft(email.ticketId, "pending");
    await call("POST", `/v1/drafts/${first.id}/discard`, "drafter");

    const res = await call("POST", `/v1/tickets/${email.ticketId}/drafts`, "drafter", {
      regenerate: true,
    });
    expect(res.status).toBe(202);
    const fresh = await waitFor("a regenerated draft", async () =>
      (await draftsOf(email.ticketId)).find((d) => d.id !== first.id && d.status === "pending"),
    );
    expect(fresh).toMatchObject({ messageId: email.messageId, body: draftText });
    expect(await live(email.ticketId)).toHaveLength(1);
  });

  it("refuses once the latest message already has an approved reply", async () => {
    const email = await receiveEmail();
    const pending = await waitForDraft(email.ticketId, "pending");
    await call("POST", `/v1/drafts/${pending.id}/approve`, "approver", { body: pending.body });
    const res = await call("POST", `/v1/tickets/${email.ticketId}/drafts`, "drafter", {
      body: "A second answer",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_answered" });
  });

  it("checks scope, workspace and input", async () => {
    const email = await receiveEmail();
    await waitForDraft(email.ticketId, "pending");
    const path = `/v1/tickets/${email.ticketId}/drafts`;
    expect((await call("POST", path, "outsider", { body: "x" })).status).toBe(404);
    expect((await call("POST", path, "drafter", { regenerate: false })).status).toBe(400);
    expect((await call("POST", path, "drafter", { body: "x", regenerate: true })).status).toBe(400);
    expect((await call("POST", path, null, { body: "x" })).status).toBe(401);
  });
});

describe("draft API access", () => {
  it.each([
    ["GET", "/v1/tickets/00000000-0000-7000-8000-000000000000/drafts"],
    ["PATCH", "/v1/drafts/00000000-0000-7000-8000-000000000000"],
    ["POST", "/v1/drafts/00000000-0000-7000-8000-000000000000/approve"],
    ["POST", "/v1/drafts/00000000-0000-7000-8000-000000000000/discard"],
    ["POST", "/v1/drafts/not-a-uuid/approve"],
  ])("%s %s is 401 without credentials, and by default for everyone", async (method, path) => {
    const body = method === "GET" ? undefined : { body: "x" };
    expect((await call(method, path, null, body)).status).toBe(401);
    // createApp() without an authenticator refuses even a request that looks authenticated.
    const res = await createApp({ db, files, logger, inboundSecret: undefined }).request(path, {
      method,
      headers: { authorization: "Bearer approver", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status).toBe(401);
  });

  it("another workspace sees Acme's ticket and draft as not found, and can't approve it", async () => {
    const email = await receiveEmail();
    const pending = await waitForDraft(email.ticketId, "pending");
    expect((await call("GET", `/v1/tickets/${email.ticketId}/drafts`, "outsider")).status).toBe(
      404,
    );
    expect(
      (await call("PATCH", `/v1/drafts/${pending.id}`, "outsider", { body: "x" })).status,
    ).toBe(404);
    expect(
      (await call("POST", `/v1/drafts/${pending.id}/approve`, "outsider", { body: pending.body }))
        .status,
    ).toBe(404);
    expect((await draftsOf(email.ticketId))[0]?.status).toBe("pending");
  });

  it("the routes are in the OpenAPI spec", async () => {
    const spec = (await (await app().request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(spec.paths["/v1/tickets/{id}/drafts"] ?? {})).toEqual(["get", "post"]);
    expect(Object.keys(spec.paths["/v1/drafts/{id}"] ?? {})).toEqual(["patch"]);
    expect(Object.keys(spec.paths["/v1/drafts/{id}/approve"] ?? {})).toEqual(["post"]);
    expect(Object.keys(spec.paths["/v1/drafts/{id}/discard"] ?? {})).toEqual(["post"]);
  });
});
