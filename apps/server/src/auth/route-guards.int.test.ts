import { type AuthStore, createAuthStore, createDatabase, type Database, schema } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { composeServices } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";

const origin = "http://localhost:3000";
const password = "route guard test password";
let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let tenantId: string;
let ownerId: string;
let ownerCookie: string;
let memberCookie: string;

const app = () =>
  createApp(
    composeServices({
      db,
      auth,
      files: createMemoryFileStore(),
      logger: { error: () => {}, warn: () => {}, info: () => {} },
      config: { publicUrl: origin },
    }),
  );

function call(
  method: string,
  path: string,
  credentials: { cookie?: string; token?: string } = {},
  body?: string,
) {
  return app().request(path, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(credentials.cookie ? { cookie: credentials.cookie } : {}),
      ...(credentials.token ? { authorization: `Bearer ${credentials.token}` } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
}

async function signIn(email: string): Promise<string> {
  const user = await auth.ensureUser(email);
  const { token } = await auth.issueSetupToken(user.id);
  expect(
    (await call("POST", "/v1/auth/password", {}, JSON.stringify({ token, password }))).status,
  ).toBe(204);
  const res = await call("POST", "/v1/auth/sign-in", {}, JSON.stringify({ email, password }));
  expect(res.status).toBe(204);
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function token() {
  const res = await call(
    "POST",
    "/v1/tokens",
    { cookie: ownerCookie },
    JSON.stringify({ name: "guard-bot", scopes: ["knowledge:read"] }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

async function audits() {
  return db.withTenant(tenantId, (tx) =>
    tx
      .select({
        action: schema.auditEvents.action,
        actorType: schema.auditEvents.actorType,
        actorId: schema.auditEvents.actorId,
        targetId: schema.auditEvents.targetId,
      })
      .from(schema.auditEvents),
  );
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl, {
    sessions: {
      secret: "route-guards-test-secret-at-least-32-characters",
      baseUrl: origin,
      cookiePrefix: "route-guards",
    },
  });
  const workspace = await initWorkspace(
    { db, auth },
    { workspace: "Guards", mailbox: "support@guards.test", owner: "owner@guards.test" },
  );
  if (!workspace.ok) throw new Error("workspace setup failed");
  tenantId = workspace.tenantId;
  ownerId = (await auth.ensureUser("owner@guards.test")).id;
  const member = await auth.ensureUser("member@guards.test");
  await db.withTenant(tenantId, (tx) =>
    tx.insert(schema.memberships).values({ tenantId, userId: member.id, role: "member" }),
  );
  ownerCookie = await signIn("owner@guards.test");
  memberCookie = await signIn("member@guards.test");
});

afterAll(async () => {
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("public API access guards with real sessions, tokens and Postgres", () => {
  it("denies writes before validation, preserves the victim and audits self and admin revocation exactly once", async () => {
    const agent = await token();
    const victim = await token();
    const before = await audits();
    for (const credentials of [{}, { cookie: memberCookie }, { token: agent.token }]) {
      const status = Object.keys(credentials).length === 0 ? 401 : 403;
      expect((await call("POST", "/v1/tokens", credentials, "{")).status).toBe(status);
      expect((await call("PATCH", "/v1/workspace/shadow-mode", credentials, "{")).status).toBe(
        status,
      );
      expect((await call("DELETE", "/v1/tokens/not-a-uuid", credentials)).status).toBe(status);
      expect((await call("DELETE", `/v1/tokens/${victim.id}`, credentials)).status).toBe(status);
    }
    expect((await call("GET", "/v1/me", { token: victim.token })).status).toBe(200);
    expect(await audits()).toEqual(before);
    expect((await call("DELETE", `/v1/tokens/${agent.id}`, { token: agent.token })).status).toBe(
      204,
    );
    expect((await call("GET", "/v1/me", { token: agent.token })).status).toBe(401);
    expect((await call("DELETE", `/v1/tokens/${victim.id}`, { cookie: ownerCookie })).status).toBe(
      204,
    );
    expect((await call("DELETE", `/v1/tokens/${victim.id}`, { cookie: ownerCookie })).status).toBe(
      204,
    );
    expect((await call("GET", "/v1/me", { token: victim.token })).status).toBe(401);
    const res = await call("GET", "/v1/tokens", { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as { tokens: { id: string; revokedAt: string | null }[] };
    for (const id of [agent.id, victim.id]) {
      expect(listed.tokens.find((row) => row.id === id)?.revokedAt).toEqual(expect.any(String));
    }
    expect((await audits()).filter((row) => row.action === "api_token.revoked")).toEqual(
      expect.arrayContaining([
        { action: "api_token.revoked", actorType: "agent", actorId: agent.id, targetId: agent.id },
        { action: "api_token.revoked", actorType: "user", actorId: ownerId, targetId: victim.id },
      ]),
    );
    expect((await audits()).filter((row) => row.action === "api_token.revoked")).toHaveLength(2);
  });

  it("keeps shadow mode locked, persists an owner's recipient change and records its actor", async () => {
    const before = await audits();
    const unknownField = await call(
      "PATCH",
      "/v1/workspace/shadow-mode",
      { cookie: ownerCookie },
      '{"recipient":"review@guards.test","aiDailyTokenBudget":1000000}',
    );
    expect(unknownField.status).toBe(400);
    expect(
      (
        await call(
          "PATCH",
          "/v1/workspace/shadow-mode",
          { cookie: ownerCookie },
          '{"enabled":false}',
        )
      ).status,
    ).toBe(409);
    expect(await audits()).toEqual(before);
    const res = await call(
      "PATCH",
      "/v1/workspace/shadow-mode",
      { cookie: ownerCookie },
      '{"recipient":"review@guards.test"}',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, recipient: "review@guards.test" });
    const read = await call("GET", "/v1/workspace/shadow-mode", { cookie: ownerCookie });
    expect(await read.json()).toEqual({ enabled: true, recipient: "review@guards.test" });
    expect(await audits()).toContainEqual({
      action: "workspace.shadow_recipient_changed",
      actorType: "user",
      actorId: ownerId,
      targetId: tenantId,
    });
    const restore = await call(
      "PATCH",
      "/v1/workspace/shadow-mode",
      { cookie: ownerCookie },
      '{"recipient":"owner@guards.test"}',
    );
    expect(restore.status).toBe(200);
  });

  it("runs the reviewed auth audit exceptions without workspace audit rows and invalidates the signed-out session", async () => {
    const before = await audits();
    const cookie = await signIn("member@guards.test");
    expect((await call("GET", "/v1/me", { cookie })).status).toBe(200);
    expect((await call("POST", "/v1/auth/sign-out", { cookie })).status).toBe(204);
    expect((await call("GET", "/v1/me", { cookie })).status).toBe(401);
    expect(await audits()).toEqual(before);
  });
});
