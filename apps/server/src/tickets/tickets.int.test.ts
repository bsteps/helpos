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
import { draftReplyJob } from "../drafts/jobs.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";

// The ticket read API against real Postgres: what an agent or the inbox screen sees.

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
  reader: () => principal(acme, ["tickets:read"]),
  drafter: () => principal(acme, ["drafts:write"]),
  outsider: () => principal(other, ["tickets:read"]),
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
const get = (path: string, as: string | null) =>
  app().request(path, as ? { headers: { authorization: `Bearer ${as}` } } : {});

type TicketJson = {
  id: string;
  subject: string;
  status: string;
  customer: { email: string; name: string | null };
  lastMessageAt: string;
  automated: boolean;
  aiPausedReason: string | null;
};
type MessageJson = { direction: string; from: { address: string }; text: string; to: string[] };

let emailCount = 0;
async function receiveEmail(options: { to?: string; html?: string; text?: string } = {}) {
  emailCount++;
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    `To: ${options.to ?? "support@acme.test"}`,
    `Subject: Question ${emailCount}`,
    `Message-ID: <tickets-${emailCount}@customer.test>`,
    `Content-Type: text/${options.html ? "html" : "plain"}; charset=utf-8`,
    "",
    options.html ?? options.text ?? "Hi, a question.",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return result.ticketId;
}

const setTicket = (id: string, values: Partial<typeof schema.tickets.$inferInsert>) =>
  db.withTenant(acme, (tx) =>
    tx.update(schema.tickets).set(values).where(eq(schema.tickets.id, id)),
  );

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  // Inbound mail queues a draft job; nothing works it here.
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await runner.ensureQueue(draftReplyJob);
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
  await testDb?.container.stop();
});

describe("GET /v1/tickets", () => {
  it("lists the workspace's tickets, most recent activity first, up to the limit", async () => {
    const older = await receiveEmail();
    const newer = await receiveEmail();
    const theirs = await receiveEmail({ to: "help@other.test" });
    await setTicket(older, { lastMessageAt: new Date("2026-11-01T10:00:00Z") });
    await setTicket(newer, { lastMessageAt: new Date("2026-11-02T10:00:00Z") });

    const res = await get("/v1/tickets", "reader");
    expect(res.status).toBe(200);
    const { tickets } = (await res.json()) as { tickets: TicketJson[] };
    expect(tickets.map((t) => t.id).slice(0, 2)).toEqual([newer, older]);
    expect(tickets.map((t) => t.id)).not.toContain(theirs);
    expect(tickets[0]).toMatchObject({
      status: "open",
      customer: { email: "jane@customer.test", name: "Jane Customer" },
      lastMessageAt: "2026-11-02T10:00:00.000Z",
      automated: false,
      aiPausedReason: null,
    });

    const limited = await get("/v1/tickets?limit=1", "reader");
    expect(((await limited.json()) as { tickets: TicketJson[] }).tickets).toHaveLength(1);
  });

  it.each(["0", "101", "x"])("refuses limit=%s with 400", async (limit) => {
    expect((await get(`/v1/tickets?limit=${limit}`, "reader")).status).toBe(400);
  });
});

describe("GET /v1/tickets/{id}", () => {
  it("returns the ticket with its messages as text, never as HTML", async () => {
    const id = await receiveEmail({
      html: "<p>Hello <b>team</b></p><script>alert(1)</script><img src=https://x.test/t.gif>",
    });
    const res = await get(`/v1/tickets/${id}`, "reader");
    expect(res.status).toBe(200);
    const ticket = (await res.json()) as TicketJson & { messages: MessageJson[] };
    expect(ticket).toMatchObject({ id, subject: expect.stringMatching(/^Question/) });
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toMatchObject({
      direction: "inbound",
      from: { address: "jane@customer.test" },
      to: ["support@acme.test"],
      text: "Hello team",
    });
    // Any case: an uppercase <SCRIPT> getting through is just as bad.
    expect(JSON.stringify(ticket)).not.toMatch(/<\s*(script|img|p)\b/i);
  });

  it("says when the AI skipped the ticket because the daily budget was spent", async () => {
    const id = await receiveEmail();
    await setTicket(id, { aiPausedReason: "daily_budget" });
    const ticket = (await (await get(`/v1/tickets/${id}`, "reader")).json()) as TicketJson;
    expect(ticket.aiPausedReason).toBe("daily_budget");
  });

  it("is 404 for another workspace's ticket, the same as an unknown one", async () => {
    const id = await receiveEmail();
    const theirs = await get(`/v1/tickets/${id}`, "outsider");
    const unknown = await get("/v1/tickets/00000000-0000-7000-8000-000000000000", "reader");
    expect([theirs.status, unknown.status]).toEqual([404, 404]);
    expect(await theirs.json()).toEqual(await unknown.json());
  });
});

describe("ticket API access", () => {
  it.each(["/v1/tickets", "/v1/tickets/00000000-0000-7000-8000-000000000000"])(
    "%s needs tickets:read, and credentials",
    async (path) => {
      expect((await get(path, "drafter")).status).toBe(403);
      expect((await get(path, null)).status).toBe(401);
    },
  );
});
