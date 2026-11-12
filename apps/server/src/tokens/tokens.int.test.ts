import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type AuthStore,
  and,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { type Authenticate, authenticateRequest, type Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { agentTokens } from "./authenticate.ts";
import { generateToken, hashToken } from "./token.ts";

// Agent tokens end to end, against real Postgres and RLS: a human creates a token, an agent
// works the inbox with it, and the audit log names the agent. Human sessions don't exist yet
// (#46), so the test stands in for one at the same seam #46 will plug into.

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const allTokenScopes = [
  "conversations:read",
  "drafts:write",
  "drafts:approve",
  "knowledge:read",
  "knowledge:write",
  "github:write",
  "stats:read",
] as const;

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;
let other: string;
let acmeConversation: string;
let otherConversation: string;

/** Stand-in sessions, keyed by the `session` cookie's value. */
const sessions: Record<string, () => { tenantId: string; scopes: Scope[] }> = {
  owner: () => ({ tenantId: acme, scopes: [...allTokenScopes, "workspace:admin"] }),
  member: () => ({ tenantId: acme, scopes: [...allTokenScopes] }),
  readOnlyAdmin: () => ({ tenantId: acme, scopes: ["conversations:read", "workspace:admin"] }),
  otherOwner: () => ({ tenantId: other, scopes: [...allTokenScopes, "workspace:admin"] }),
};
const session: Authenticate = async (request) => {
  const name = request.headers.get("cookie")?.match(/session=(\w+)/)?.[1] ?? "";
  const found = sessions[name]?.();
  if (!found) return null;
  return {
    tenantId: found.tenantId,
    actor: { type: "user", id: `user-${name}` },
    scopes: new Set(found.scopes),
  };
};

const app = () =>
  createApp(composeServices({ db, files, logger }), {
    authenticate: authenticateRequest({ tokens: agentTokens(db), session }),
  });

type As = { session: string } | { token: string } | { authorization: string } | null;
function call(method: string, path: string, as: As, body?: object) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as && "session" in as) headers.cookie = `session=${as.session}`;
  if (as && "token" in as) headers.authorization = `Bearer ${as.token}`;
  if (as && "authorization" in as) headers.authorization = as.authorization;
  return app().request(path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

type CreatedToken = { id: string; name: string; scopes: string[]; token: string };
async function createToken(
  scopes: string[],
  as: As = { session: "owner" },
  name = "bot",
): Promise<CreatedToken> {
  const res = await call("POST", "/v1/tokens", as, { name, scopes });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as CreatedToken;
}

const auditFor = (tenantId: string, targetId: string) =>
  db.withTenant(tenantId, (tx) =>
    tx
      .select({
        action: schema.auditEvents.action,
        actorType: schema.auditEvents.actorType,
        actorId: schema.auditEvents.actorId,
      })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, targetId))
      .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id)),
  );

async function receiveEmail(to: string, n: number): Promise<string> {
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    `To: ${to}`,
    `Subject: Cannot log in ${n}`,
    `Message-ID: <tokens-${n}@customer.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi, I cannot log in since this morning.",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return result.conversationId;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  // Every queue, so the routes can enqueue: no job is worked here.
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
  acmeConversation = await receiveEmail("support@acme.test", 1);
  otherConversation = await receiveEmail("help@other.test", 2);
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("an agent token works the inbox", () => {
  it("lists conversations and creates a draft, and the audit log shows the agent as actor", async () => {
    const agent = await createToken(
      ["conversations:read", "drafts:write"],
      { session: "owner" },
      "triage",
    );

    const list = await call("GET", "/v1/conversations", { token: agent.token });
    expect(list.status).toBe(200);
    const { conversations } = (await list.json()) as { conversations: { id: string }[] };
    expect(conversations.map((t) => t.id)).toEqual([acmeConversation]);

    const created = await call(
      "POST",
      `/v1/conversations/${acmeConversation}/drafts`,
      { token: agent.token },
      {
        body: "Hi Jane, we're looking into it.",
      },
    );
    expect(created.status).toBe(201);
    const draft = (await created.json()) as { id: string };

    expect(await auditFor(acme, draft.id)).toEqual([
      { action: "draft.created", actorType: "agent", actorId: agent.id },
    ]);
  });

  it("uses the knowledge routes with the knowledge scopes", async () => {
    const reader = await createToken(["knowledge:read"]);
    const writer = await createToken(["knowledge:read", "knowledge:write"]);
    const source = { kind: "markdown", title: "Refunds", content: "Refunds take 5 days." };

    expect((await call("GET", "/v1/knowledge/sources", { token: reader.token })).status).toBe(200);
    expect(
      (await call("POST", "/v1/knowledge/sources", { token: reader.token }, source)).status,
    ).toBe(403);
    const added = await call("POST", "/v1/knowledge/sources", { token: writer.token }, source);
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };
    expect(await auditFor(acme, id)).toEqual([
      { action: "knowledge_source.created", actorType: "agent", actorId: writer.id },
    ]);

    const path = `/v1/knowledge/sources/${id}`;
    const publish = { visibility: "public" };
    expect((await call("PATCH", path, { token: reader.token }, publish)).status).toBe(403);
    expect((await call("PATCH", path, { token: writer.token }, publish)).status).toBe(200);
    expect(await auditFor(acme, id)).toEqual([
      { action: "knowledge_source.created", actorType: "agent", actorId: writer.id },
      { action: "knowledge_source.made_public", actorType: "agent", actorId: writer.id },
    ]);
  });

  it("uses the GitHub routes with github:write, but can never connect a repo", async () => {
    const github = await createToken(["conversations:read", "github:write"]);
    const reader = await createToken(["conversations:read"]);
    const read = await call("GET", "/v1/integrations/github", { token: github.token });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ connected: false, repo: null, webhookUrl: null });
    expect((await call("GET", "/v1/integrations/github", { token: reader.token })).status).toBe(
      403,
    );
    // Past the scope check: this server has no AI model, so it says so instead of 403.
    const draft = await call("POST", `/v1/conversations/${acmeConversation}/github-issue/draft`, {
      token: github.token,
    });
    expect(draft.status).toBe(503);
    expect(
      (
        await call("POST", `/v1/conversations/${acmeConversation}/github-issue/draft`, {
          token: reader.token,
        })
      ).status,
    ).toBe(403);
    // Storing a token is for a human owner: an agent token is refused whatever it holds.
    const connect = { repo: "acme/app", token: "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    expect(
      (await call("PUT", "/v1/integrations/github", { token: github.token }, connect)).status,
    ).toBe(403);
    expect((await call("DELETE", "/v1/integrations/github", { token: github.token })).status).toBe(
      403,
    );
  });

  it("sees another workspace's conversation as not found", async () => {
    const agent = await createToken(["conversations:read", "drafts:write"]);
    expect(
      (await call("GET", `/v1/conversations/${otherConversation}`, { token: agent.token })).status,
    ).toBe(404);
    expect(
      (
        await call(
          "POST",
          `/v1/conversations/${otherConversation}/drafts`,
          { token: agent.token },
          { body: "x" },
        )
      ).status,
    ).toBe(404);
  });
});

describe("token auth", () => {
  it("wrong scope: 403", async () => {
    const reader = await createToken(["conversations:read"]);
    const drafter = await createToken(["conversations:read", "drafts:write"]);
    const anyDraft = "/v1/drafts/00000000-0000-7000-8000-000000000000";

    expect(
      (
        await call(
          "POST",
          `/v1/conversations/${acmeConversation}/drafts`,
          { token: reader.token },
          { body: "x" },
        )
      ).status,
    ).toBe(403);
    // Drafting doesn't include sending: approving needs `drafts:approve`.
    expect(
      (await call("POST", `${anyDraft}/approve`, { token: drafter.token }, { body: "x" })).status,
    ).toBe(403);
    expect((await call("GET", "/v1/knowledge/sources", { token: drafter.token })).status).toBe(403);
    expect(
      (
        await call(
          "PATCH",
          "/v1/workspace/shadow-mode",
          { token: drafter.token },
          { enabled: true },
        )
      ).status,
    ).toBe(403);
  });

  it("revoked: 401", async () => {
    const agent = await createToken(["conversations:read"]);
    expect((await call("GET", "/v1/conversations", { token: agent.token })).status).toBe(200);
    expect((await call("DELETE", `/v1/tokens/${agent.id}`, { session: "owner" })).status).toBe(204);
    expect((await call("GET", "/v1/conversations", { token: agent.token })).status).toBe(401);
    expect(await auditFor(acme, agent.id)).toEqual([
      { action: "api_token.created", actorType: "user", actorId: "user-owner" },
      { action: "api_token.revoked", actorType: "user", actorId: "user-owner" },
    ]);
  });

  it.each([
    ["an unknown token", () => ({ token: generateToken().token })],
    ["a malformed token", () => ({ token: "hos_short" })],
    ["another scheme", () => ({ authorization: `Basic ${generateToken().token}` })],
    ["no credentials", () => null],
  ])("%s: 401", async (_, as) => {
    for (const path of [
      "/v1/conversations",
      `/v1/conversations/${acmeConversation}`,
      "/v1/tokens",
    ]) {
      const res = await call("GET", path, as());
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ error: "unauthorized" });
    }
  });

  it("judges a request with a bad token on the token, even next to a valid session", async () => {
    const res = await app().request("/v1/conversations", {
      headers: { cookie: "session=owner", authorization: `Bearer ${generateToken().token}` },
    });
    expect(res.status).toBe(401);
  });

  it("is on by default: createApp() accepts real tokens without being told to", async () => {
    const agent = await createToken(["conversations:read"]);
    const res = await createApp(composeServices({ db, files, logger })).request(
      "/v1/conversations",
      {
        headers: { authorization: `Bearer ${agent.token}` },
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("creating tokens", () => {
  it("shows the token once and stores only its hash", async () => {
    const res = await call(
      "POST",
      "/v1/tokens",
      { session: "owner" },
      {
        name: " triage-bot ",
        scopes: ["drafts:write", "conversations:read", "drafts:write"],
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const created = (await res.json()) as CreatedToken & { revokedAt: string | null };
    expect(created).toMatchObject({
      name: "triage-bot",
      scopes: ["conversations:read", "drafts:write"],
      revokedAt: null,
    });
    expect(created.token).toMatch(/^hos_[A-Za-z0-9_-]{43}$/);

    const [row] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, created.id)),
    );
    expect(row?.tokenHash).toBe(hashToken(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token.slice(4));

    const list = await call("GET", "/v1/tokens", { session: "owner" });
    const { tokens } = (await list.json()) as { tokens: Record<string, unknown>[] };
    const listed = tokens.find((t) => t.id === created.id);
    expect(Object.keys(listed ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "revokedAt",
      "scopes",
    ]);
  });

  it("needs a human session: an agent token can't create, list or revoke others", async () => {
    const agent = await createToken(["conversations:read"]);
    const victim = await createToken(["conversations:read"]);
    const res = await call(
      "POST",
      "/v1/tokens",
      { token: agent.token },
      {
        name: "spare",
        scopes: ["conversations:read"],
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "session_required" });
    expect((await call("GET", "/v1/tokens", { token: agent.token })).status).toBe(403);
    expect((await call("DELETE", `/v1/tokens/${victim.id}`, { token: agent.token })).status).toBe(
      403,
    );
    expect((await call("GET", "/v1/conversations", { token: victim.token })).status).toBe(200);
  });

  it("needs workspace:admin", async () => {
    const res = await call(
      "POST",
      "/v1/tokens",
      { session: "member" },
      {
        name: "bot",
        scopes: ["conversations:read"],
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
    expect((await call("GET", "/v1/tokens", { session: "member" })).status).toBe(403);
  });

  it("can't grant a scope the creator doesn't hold", async () => {
    const res = await call(
      "POST",
      "/v1/tokens",
      { session: "readOnlyAdmin" },
      {
        name: "bot",
        scopes: ["conversations:read", "drafts:approve"],
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "scope_not_held" });
  });

  it.each([
    ["workspace:admin, which no token can hold", { name: "bot", scopes: ["workspace:admin"] }],
    ["no scopes", { name: "bot", scopes: [] }],
    ["an unknown scope", { name: "bot", scopes: ["conversations:delete"] }],
    ["no name", { name: "  ", scopes: ["conversations:read"] }],
    ["an unknown field", { name: "bot", scopes: ["conversations:read"], expiresAt: "never" }],
  ])("refuses %s with 400", async (_, body) => {
    expect((await call("POST", "/v1/tokens", { session: "owner" }, body)).status).toBe(400);
  });
});

describe("revoking tokens", () => {
  it("an agent can revoke its own token", async () => {
    const agent = await createToken(["conversations:read"]);
    expect((await call("DELETE", `/v1/tokens/${agent.id}`, { token: agent.token })).status).toBe(
      204,
    );
    expect((await call("GET", "/v1/conversations", { token: agent.token })).status).toBe(401);
    expect(await auditFor(acme, agent.id)).toContainEqual({
      action: "api_token.revoked",
      actorType: "agent",
      actorId: agent.id,
    });
  });

  it("revoking twice changes nothing and logs once", async () => {
    const agent = await createToken(["conversations:read"]);
    expect((await call("DELETE", `/v1/tokens/${agent.id}`, { session: "owner" })).status).toBe(204);
    expect((await call("DELETE", `/v1/tokens/${agent.id}`, { session: "owner" })).status).toBe(204);
    const revocations = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.targetId, agent.id),
            eq(schema.auditEvents.action, "api_token.revoked"),
          ),
        ),
    );
    expect(revocations).toHaveLength(1);
  });

  it("another workspace's token is not found, and stays usable", async () => {
    const theirs = await createToken(["conversations:read"], { session: "otherOwner" });
    expect((await call("DELETE", `/v1/tokens/${theirs.id}`, { session: "owner" })).status).toBe(
      404,
    );
    expect(
      (
        await call("DELETE", "/v1/tokens/00000000-0000-7000-8000-000000000000", {
          session: "owner",
        })
      ).status,
    ).toBe(404);
    expect((await call("GET", "/v1/conversations", { token: theirs.token })).status).toBe(200);
    const list = await call("GET", "/v1/tokens", { session: "owner" });
    const { tokens } = (await list.json()) as { tokens: { id: string }[] };
    expect(tokens.map((t) => t.id)).not.toContain(theirs.id);
  });
});

describe("OpenAPI", () => {
  it("documents the token and conversation routes", async () => {
    const spec = (await (await app().request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, { security?: unknown }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(Object.keys(spec.paths["/v1/tokens"] ?? {})).toEqual(["post", "get"]);
    expect(Object.keys(spec.paths["/v1/tokens/{id}"] ?? {})).toEqual(["delete"]);
    expect(Object.keys(spec.paths["/v1/conversations"] ?? {})).toEqual(["get"]);
    expect(Object.keys(spec.paths["/v1/conversations/{id}"] ?? {})).toEqual(["get"]);
    expect(spec.paths["/v1/tokens"]?.post?.security).toEqual([{ apiAuth: [] }]);
    expect(spec.components.securitySchemes.apiAuth).toMatchObject({ scheme: "bearer" });
  });
});

describe("pnpm helpos:token", () => {
  const cli = fileURLToPath(new URL("../cli/token.ts", import.meta.url));
  /** Runs the real CLI in its own process, the way an operator would. */
  async function runCli(args: string[]) {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli, ...args], {
        env: { ...process.env, HELPOS_DATABASE_URL: testDb.appUrl },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("prints a working token, alone on stdout, and audits it as the CLI", async () => {
    const run = await runCli([
      "--mailbox",
      "Support@Acme.test",
      "--name",
      "ops-bot",
      "--scopes",
      "conversations:read, drafts:write",
    ]);
    expect(run.code).toBe(0);
    const token = run.stdout.trim();
    expect(token).toMatch(/^hos_[A-Za-z0-9_-]{43}$/);
    expect(run.stderr).not.toContain(token);

    expect((await call("GET", "/v1/conversations", { token })).status).toBe(200);
    const found = await db.resolveApiToken(hashToken(token));
    expect(found).toMatchObject({ tenantId: acme, name: "ops-bot" });
    expect(found?.scopes).toEqual(["conversations:read", "drafts:write"]);
    expect(await auditFor(acme, found?.id ?? "")).toEqual([
      { action: "api_token.created", actorType: "system", actorId: "cli" },
    ]);
  });

  it("refuses an unknown mailbox, and scopes no token can hold", async () => {
    const unknown = await runCli([
      "--mailbox",
      "nobody@nowhere.test",
      "--name",
      "x",
      "--scopes",
      "conversations:read",
    ]);
    expect([unknown.code, unknown.stdout]).toEqual([1, ""]);
    const admin = await runCli([
      "--mailbox",
      "support@acme.test",
      "--name",
      "x",
      "--scopes",
      "workspace:admin",
    ]);
    expect([admin.code, admin.stdout]).toEqual([2, ""]);
  });
});
