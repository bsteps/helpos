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
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";

// The conversation read API against real Postgres: what an agent or the inbox screen sees.

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;
let other: string;

/** Test credentials: the bearer value names a principal (real tokens: tokens.int.test.ts). */
const principals: Record<string, () => Principal> = {
  reader: () => principal(acme, ["conversations:read"]),
  drafter: () => principal(acme, ["drafts:write"]),
  outsider: () => principal(other, ["conversations:read"]),
  closer: () => principal(acme, ["conversations:read", "conversations:write"]),
  outsiderCloser: () => principal(other, ["conversations:read", "conversations:write"]),
  // Can close but not read: the closed conversation it would get back shows the customer.
  blindCloser: () => principal(acme, ["conversations:write"]),
};
function principal(tenantId: string, scopes: Scope[]): Principal {
  return { tenantId, actor: { type: "agent", id: "test-agent" }, scopes: new Set(scopes) };
}

const app = () =>
  createApp(composeServices({ db, files, logger }), {
    authenticate: async (req) => {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return principals[token]?.() ?? null;
    },
  });
const get = (path: string, as: string | null) =>
  app().request(path, as ? { headers: { authorization: `Bearer ${as}` } } : {});
const post = (path: string, as: string | null) =>
  app().request(path, {
    method: "POST",
    ...(as ? { headers: { authorization: `Bearer ${as}` } } : {}),
  });

type ConversationJson = {
  id: string;
  replyNotSent?: boolean;
  subject: string;
  status: string;
  customer: { email: string; name: string | null };
  lastMessageAt: string;
  automated: boolean;
  aiPausedReason: string | null;
};
type MessageJson = {
  direction: string;
  from: { address: string };
  text: string;
  html: string | null;
  to: string[];
};

let emailCount = 0;
async function receiveEmail(options: { to?: string; html?: string; text?: string } = {}) {
  emailCount++;
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    `To: ${options.to ?? "support@acme.test"}`,
    `Subject: Question ${emailCount}`,
    `Message-ID: <conversations-${emailCount}@customer.test>`,
    `Content-Type: text/${options.html ? "html" : "plain"}; charset=utf-8`,
    "",
    options.html ?? options.text ?? "Hi, a question.",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return result.conversationId;
}

const setConversation = (id: string, values: Partial<typeof schema.conversations.$inferInsert>) =>
  db.withTenant(acme, (tx) =>
    tx.update(schema.conversations).set(values).where(eq(schema.conversations.id, id)),
  );

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  // Inbound mail queues a draft job; nothing works it here.
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await ensureJobQueues(runner, defaultConfig);
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
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("GET /v1/conversations", () => {
  it("lists the workspace's conversations, most recent activity first, up to the limit", async () => {
    const older = await receiveEmail();
    const newer = await receiveEmail();
    const theirs = await receiveEmail({ to: "help@other.test" });
    await setConversation(older, { lastMessageAt: new Date("2026-11-01T10:00:00Z") });
    await setConversation(newer, { lastMessageAt: new Date("2026-11-02T10:00:00Z") });

    const res = await get("/v1/conversations", "reader");
    expect(res.status).toBe(200);
    const { conversations } = (await res.json()) as { conversations: ConversationJson[] };
    expect(conversations.map((t) => t.id).slice(0, 2)).toEqual([newer, older]);
    expect(conversations.map((t) => t.id)).not.toContain(theirs);
    expect(conversations[0]).toMatchObject({
      status: "open",
      customer: { email: "jane@customer.test", name: "Jane Customer" },
      lastMessageAt: "2026-11-02T10:00:00.000Z",
      automated: false,
      aiPausedReason: null,
    });

    const limited = await get("/v1/conversations?limit=1", "reader");
    expect(
      ((await limited.json()) as { conversations: ConversationJson[] }).conversations,
    ).toHaveLength(1);
  });

  it.each(["0", "101", "x"])("refuses limit=%s with 400", async (limit) => {
    expect((await get(`/v1/conversations?limit=${limit}`, "reader")).status).toBe(400);
  });
});

describe("GET /v1/conversations/{id}", () => {
  it("returns the conversation with its messages as text, and HTML only sanitised", async () => {
    const id = await receiveEmail({
      html: "<p>Hello <b>team</b></p><script>alert(1)</script><img src=https://x.test/t.gif>",
    });
    const res = await get(`/v1/conversations/${id}`, "reader");
    expect(res.status).toBe(200);
    const conversation = (await res.json()) as ConversationJson & { messages: MessageJson[] };
    expect(conversation).toMatchObject({ id, subject: expect.stringMatching(/^Question/) });
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      direction: "inbound",
      from: { address: "jane@customer.test" },
      to: ["support@acme.test"],
      text: "Hello team",
      // The remote image is replaced, so opening the email never tells the sender.
      html: "<p>Hello <b>team</b></p><span>[image]</span>",
    });
    // Any case: an uppercase <SCRIPT> getting through is just as bad.
    expect(JSON.stringify(conversation)).not.toMatch(/<\s*(script|img)\b|x\.test/i);
  });

  it("has no HTML for a plain-text email", async () => {
    const id = await receiveEmail({ text: "Just text." });
    const conversation = (await (await get(`/v1/conversations/${id}`, "reader")).json()) as {
      messages: MessageJson[];
    };
    expect(conversation.messages[0]).toMatchObject({ text: "Just text.", html: null });
  });

  it("says when the AI skipped the conversation because the daily budget was spent", async () => {
    const id = await receiveEmail();
    await setConversation(id, { aiPausedReason: "daily_budget" });
    const conversation = (await (
      await get(`/v1/conversations/${id}`, "reader")
    ).json()) as ConversationJson;
    expect(conversation.aiPausedReason).toBe("daily_budget");
  });

  it("is 404 for another workspace's conversation, the same as an unknown one", async () => {
    const id = await receiveEmail();
    const theirs = await get(`/v1/conversations/${id}`, "outsider");
    const unknown = await get("/v1/conversations/00000000-0000-7000-8000-000000000000", "reader");
    expect([theirs.status, unknown.status]).toEqual([404, 404]);
    expect(await theirs.json()).toEqual(await unknown.json());
  });
});

describe("GET /v1/conversations?status=", () => {
  it("keeps only open, or only closed, conversations", async () => {
    const open = await receiveEmail();
    const closed = await receiveEmail();
    await setConversation(closed, { status: "closed" });
    const ids = async (query: string) =>
      (
        (await (await get(`/v1/conversations?${query}`, "reader")).json()) as {
          conversations: ConversationJson[];
        }
      ).conversations.map((t) => t.id);
    expect(await ids("status=open&limit=100")).toContain(open);
    expect(await ids("status=open&limit=100")).not.toContain(closed);
    expect(await ids("status=closed&limit=100")).toContain(closed);
    expect(await ids("status=closed&limit=100")).not.toContain(open);
    expect((await get("/v1/conversations?status=pending", "reader")).status).toBe(400);
  });
});

describe("a reply that couldn't be sent", () => {
  it("flags the conversation, and keeps it in the inbox list even once closed", async () => {
    const quiet = await receiveEmail();
    const failed = await receiveEmail();
    await setConversation(quiet, { status: "closed" });
    await setConversation(failed, { status: "closed" });
    await db.withTenant(acme, async (tx) => {
      const [message] = await tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, failed));
      if (!message) throw new Error("no message");
      await tx.insert(schema.drafts).values({
        tenantId: acme,
        conversationId: failed,
        messageId: message.id,
        body: "Sorry for the wait.",
        status: "send_failed",
        approvedAt: new Date(),
        outboundMessageIdHeader: `<failed-${failed}@acme.test>`,
      });
    });
    const list = async (query: string, as = "reader") =>
      (
        (await (await get(`/v1/conversations?${query}`, as)).json()) as {
          conversations: ConversationJson[];
        }
      ).conversations;

    const inbox = await list("status=open&orReplyNotSent=true&limit=100");
    expect(inbox.find((t) => t.id === failed)).toMatchObject({
      status: "closed",
      replyNotSent: true,
    });
    expect(inbox.map((t) => t.id)).not.toContain(quiet);
    // Listed first, so a short limit still shows it.
    expect((await list("status=open&orReplyNotSent=true&limit=1"))[0]?.id).toBe(failed);
    expect(inbox.filter((t) => t.status === "closed").map((t) => t.id)).toEqual([failed]);
    // Without the flag, open means open.
    expect((await list("status=open&limit=100")).map((t) => t.id)).not.toContain(failed);
    const quietConversation = (await (
      await get(`/v1/conversations/${quiet}`, "reader")
    ).json()) as ConversationJson;
    expect(quietConversation.replyNotSent).toBe(false);

    // Another workspace never sees Acme's failed reply through its own list.
    const theirs = await list("status=open&orReplyNotSent=true&limit=100", "outsider");
    expect(theirs.map((t) => t.id)).not.toContain(failed);
  });
});

describe("POST /v1/conversations/{id}/close", () => {
  const auditOf = (id: string) =>
    db.withTenant(acme, (tx) =>
      tx
        .select({
          action: schema.auditEvents.action,
          actorType: schema.auditEvents.actorType,
          actorId: schema.auditEvents.actorId,
          requestId: schema.auditEvents.requestId,
        })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, id)),
    );

  it("closes the conversation and audit-logs who did it, once", async () => {
    const id = await receiveEmail();
    const res = await post(`/v1/conversations/${id}/close`, "closer");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: "closed" });
    // Closing again is harmless and logs nothing new.
    expect((await post(`/v1/conversations/${id}/close`, "closer")).status).toBe(200);
    expect(await auditOf(id)).toEqual([
      {
        action: "conversation.closed",
        actorType: "agent",
        actorId: "test-agent",
        requestId: res.headers.get("x-request-id"),
      },
    ]);
  });

  it("needs conversations:write and conversations:read, and can't close another workspace's conversation", async () => {
    const id = await receiveEmail();
    expect((await post(`/v1/conversations/${id}/close`, "reader")).status).toBe(403);
    expect((await post(`/v1/conversations/${id}/close`, "blindCloser")).status).toBe(403);
    expect((await post(`/v1/conversations/${id}/close`, null)).status).toBe(401);
    expect((await post(`/v1/conversations/${id}/close`, "outsiderCloser")).status).toBe(404);
    const conversation = (await (
      await get(`/v1/conversations/${id}`, "reader")
    ).json()) as ConversationJson;
    expect(conversation.status).toBe("open");
    expect(await auditOf(id)).toEqual([]);
  });
});

describe("conversation API access", () => {
  it.each(["/v1/conversations", "/v1/conversations/00000000-0000-7000-8000-000000000000"])(
    "%s needs conversations:read, and credentials",
    async (path) => {
      expect((await get(path, "drafter")).status).toBe(403);
      expect((await get(path, null)).status).toBe(401);
    },
  );
});
