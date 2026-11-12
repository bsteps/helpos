import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  type SessionAuth,
  schema,
  uuidv7,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";

// Human sign-in through the public API, against real Postgres and Better Auth: what the
// dashboard does. No test double for authentication here.

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const origin = "http://localhost:3000";
const password = "a long enough password";

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let _sessions: SessionAuth;
let runner: JobRunner;
let acme: string;
let ownerId: string;

const app = () =>
  createApp(composeServices({ db, files, logger, auth, config: { publicUrl: origin } }));

function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  if (init.origin !== null) headers.origin = init.origin ?? origin;
  return app().request(path, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** Signs in and returns the Cookie header a browser would send from then on. */
async function signIn(email: string, pw = password): Promise<string> {
  const res = await call("/v1/auth/sign-in", { method: "POST", body: { email, password: pw } });
  expect(res.status).toBe(204);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function withPassword(email: string): Promise<string> {
  const user = await auth.ensureUser(email);
  const { token } = await auth.issueSetupToken(user.id);
  expect(await auth.setPassword(token, password)).toEqual({ ok: true });
  return user.id;
}

async function receiveEmail(n: number, to = "support@acme.test"): Promise<string> {
  const raw = [
    "From: jane@customer.test",
    `To: ${to}`,
    `Subject: Session test ${n}`,
    `Message-ID: <session-${n}@customer.test>`,
    "",
    "Hi.",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return result.conversationId;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl, {
    sessions: {
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseUrl: origin,
      cookiePrefix: "helpos-test",
    },
  });
  if (!auth.sessions) throw new Error("sessions not configured");
  _sessions = auth.sessions;
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await ensureJobQueues(runner, defaultConfig);
  const result = await initWorkspace(
    { db, auth },
    { workspace: "Acme", mailbox: "support@acme.test", owner: "owner@acme.test" },
  );
  if (!result.ok) throw new Error("setup failed");
  acme = result.tenantId;
  ownerId = await withPassword("owner@acme.test");
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("sign-in", () => {
  it("sets an HttpOnly session cookie that identifies the owner and their workspace", async () => {
    const res = await call("/v1/auth/sign-in", {
      method: "POST",
      body: { email: "owner@acme.test", password },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("helpos-test.session"));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await call("/v1/me", { cookie: await signIn("owner@acme.test") });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { actor: unknown; workspace: unknown; scopes: string[] };
    expect(body.actor).toEqual({ type: "user", id: ownerId });
    expect(body.workspace).toEqual({ id: acme, name: "Acme" });
    expect(body.scopes).toContain("workspace:admin");
    expect(body.scopes).toContain("conversations:write");
  });

  it("answers a wrong password and an unknown email the same way, with no cookie", async () => {
    for (const body of [
      { email: "owner@acme.test", password: "not the right one" },
      { email: "nobody@acme.test", password },
    ]) {
      const res = await call("/v1/auth/sign-in", { method: "POST", body });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("refuses a sign-in posted by another site (login CSRF)", async () => {
    const res = await call("/v1/auth/sign-in", {
      method: "POST",
      body: { email: "owner@acme.test", password },
      origin: "https://evil.test",
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("is 503 when the server has no session secret", async () => {
    const res = await createApp(composeServices({ db, files, logger })).request(
      "/v1/auth/sign-in",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@acme.test", password }),
      },
    );
    expect(res.status).toBe(503);
  });
});

describe("a session cookie", () => {
  it("can close a conversation, audit-logged as the user", async () => {
    const id = await receiveEmail(1);
    const res = await call(`/v1/conversations/${id}/close`, {
      method: "POST",
      cookie: await signIn("owner@acme.test"),
    });
    expect(res.status).toBe(200);
    const events = await db.withTenant(acme, (tx) =>
      tx
        .select({ actorType: schema.auditEvents.actorType, actorId: schema.auditEvents.actorId })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, id)),
    );
    expect(events).toEqual([{ actorType: "user", actorId: ownerId }]);
  });

  it("is ignored on a write sent from another site (CSRF), and nothing changes", async () => {
    const id = await receiveEmail(2);
    const res = await call(`/v1/conversations/${id}/close`, {
      method: "POST",
      cookie: await signIn("owner@acme.test"),
      origin: "https://evil.test",
    });
    expect(res.status).toBe(401);
    const conversation = await db.withTenant(acme, (tx) =>
      tx
        .select({ status: schema.conversations.status })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, id)),
    );
    expect(conversation).toEqual([{ status: "open" }]);
  });

  it("never rescues a bad bearer token sent next to it", async () => {
    const res = await app().request("/v1/me", {
      headers: { cookie: await signIn("owner@acme.test"), authorization: "Bearer hos_wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("gives a member everything but workspace administration", async () => {
    const memberId = await withPassword("member@acme.test");
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.memberships).values({ tenantId: acme, userId: memberId, role: "member" }),
    );
    const cookie = await signIn("member@acme.test");
    const me = (await (await call("/v1/me", { cookie })).json()) as { scopes: string[] };
    expect(me.scopes).toContain("drafts:approve");
    expect(me.scopes).not.toContain("workspace:admin");
    const token = await call("/v1/tokens", {
      method: "POST",
      cookie,
      body: { name: "bot", scopes: ["conversations:read"] },
    });
    expect(token.status).toBe(403);
  });

  it("of a user with no workspace opens nothing", async () => {
    await withPassword("loner@acme.test");
    const cookie = await signIn("loner@acme.test");
    expect((await call("/v1/me", { cookie })).status).toBe(401);
    expect((await call("/v1/conversations", { cookie })).status).toBe(401);
  });

  it("leak: session of user in A cannot open tenant B", async () => {
    const other = await initWorkspace(
      { db, auth },
      { workspace: "Other", mailbox: "help@other.test", owner: "owner@other.test" },
    );
    if (!other.ok) throw new Error("setup failed");
    const theirConversation = await receiveEmail(3, "help@other.test");
    const memberId = await withPassword("analyst@acme.test");
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.memberships).values({ tenantId: acme, userId: memberId, role: "member" }),
    );
    const cookie = await signIn("analyst@acme.test");

    const me = await call("/v1/me", { cookie });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { workspace: unknown }).workspace).toEqual({
      id: acme,
      name: "Acme",
    });

    const unknown = await call(`/v1/conversations/${uuidv7()}`, { cookie });
    const theirs = await call(`/v1/conversations/${theirConversation}`, { cookie });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    const theirRequestId = theirs.headers.get("x-request-id");
    const unknownRequestId = unknown.headers.get("x-request-id");
    expect(theirRequestId).toBeTruthy();
    expect(unknownRequestId).toBeTruthy();
    expect((await theirs.text()).replace(theirRequestId ?? "missing", "request-id")).toEqual(
      (await unknown.text()).replace(unknownRequestId ?? "missing", "request-id"),
    );
    const list = await (await call("/v1/conversations", { cookie })).text();
    expect(list).not.toContain(theirConversation);
    expect(list).not.toContain(other.tenantId);
  });

  it("stops working after sign-out", async () => {
    const cookie = await signIn("owner@acme.test");
    const out = await call("/v1/auth/sign-out", { method: "POST", cookie });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().some((c) => /Max-Age=0/i.test(c))).toBe(true);
    expect((await call("/v1/me", { cookie })).status).toBe(401);
  });
});

describe("POST /v1/auth/password", () => {
  it("sets the password with a one-time link, then the link is spent", async () => {
    const user = await auth.ensureUser("new@acme.test");
    const { token } = await auth.issueSetupToken(user.id);
    const set = await call("/v1/auth/password", {
      method: "POST",
      body: { token, password: "my new long password" },
    });
    expect(set.status).toBe(204);
    await signIn("new@acme.test", "my new long password");
    const again = await call("/v1/auth/password", {
      method: "POST",
      body: { token, password: "someone else's try" },
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_token" });
  });

  it("refuses a password shorter than 12 characters before touching the token", async () => {
    const user = await auth.ensureUser("short@acme.test");
    const { token } = await auth.issueSetupToken(user.id);
    const res = await call("/v1/auth/password", {
      method: "POST",
      body: { token, password: "too short" },
    });
    expect(res.status).toBe(400);
    expect(await auth.setPassword(token, "now long enough!")).toEqual({ ok: true });
  });
});
