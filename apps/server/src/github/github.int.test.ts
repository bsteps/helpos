import { randomBytes } from "node:crypto";
import type { LanguageModel } from "@helpos/ai";
import { failingModel, mockModel, refusingModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  and,
  asc,
  createAuthStore,
  createDatabase,
  type Database,
  eq,
  type JobRunner,
  schema,
  sql,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { aiBudget } from "../ai-budget/budget.ts";
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { intendedToHeader } from "../outbound-email/shadow.ts";
import type { EmailTransport } from "../outbound-email/transport.ts";
import { createSecretBox } from "../secrets/secret-box.ts";
import { composeServer, type Server } from "../server.ts";
import { defaultConfig, systemClock } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { addFixedDraft, fixedNoticeBody, githubWebhookActor } from "./fixed-notice.ts";
import { octokitGithub } from "./github-api.ts";
import { registerGithubWebhook } from "./webhook.ts";
import { signWebhook } from "./webhook-signature.ts";

// Conversation → GitHub issue → customer told when it's fixed, against real Postgres, RLS, pg-boss and
// the real Octokit. GitHub itself is a fake `fetch`: no test ever calls GitHub.

const pat = "github_pat_11TESTTOKEN0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const badPat = "github_pat_11REVOKED00abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ";
const replyText = "Thanks, we're looking into it.";
const issueJson = {
  title: "Export fails for @boss",
  summary: "CSV export returns an error. See https://evil.test/patch and #1.",
  stepsToReproduce: ["Open Reports", "Click Export CSV"],
  expected: "A CSV file downloads.",
  actual: "An error page.",
};

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const box = createSecretBox(randomBytes(32));
const issueModel = mockModel({
  text: JSON.stringify(issueJson),
  usage: { inputTokens: 300, outputTokens: 100 },
});

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
/** The API and the worker, built from one set of services as in the real server. */
let helpos: Server;
let acme: string;
let other: string;

// --- Fake GitHub: what Octokit sent, and what GitHub answers -----------------------------------

type GithubCall = { method: string; path: string; authorization: string | null; body: unknown };
const githubCalls: GithubCall[] = [];
let githubDown = false;
/** GitHub opens the issue, then the answer is lost (a 504 from its edge). */
let loseCreateAnswer = false;
/** The issue list lags behind: issues just opened aren't listed yet. */
let listLags = false;
/** GitHub refuses the create outright (a 422): nothing was opened. */
let rejectCreate = false;
/** Runs while GitHub "creates" the issue, e.g. to take this request's claim away meanwhile. */
let duringCreate: (() => Promise<void>) | undefined;
let nextIssue = 100;
/** The account the test token belongs to. */
const botLogin = "helpdesk-bot";
const openedIssues: {
  number: number;
  title: string;
  body: string;
  created_at: string;
  user: { login: string };
  state?: "open" | "closed";
  state_reason?: string | null;
}[] = [];
/** The issue list never ends: page after page of other people's issues opened just now. */
let endlessList = false;
/** The token can't read its own account (as some app tokens can't). */
let userHidden = false;
/** Runs when the issue's state is read, after the link is written. */
let duringStateCheck: (() => Promise<void>) | undefined;
/** How many of the next reads of an issue's state fail, and with which status. */
let stateFailures = 0;
let stateFailureStatus = 503;

const fakeGithubFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  const text = await request.text();
  const authorization = request.headers.get("authorization");
  githubCalls.push({
    method: request.method,
    path,
    authorization,
    body: text ? JSON.parse(text) : undefined,
  });
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (githubDown) return reply(503, { message: "unavailable" });
  if (authorization !== `token ${pat}`) return reply(401, { message: "Bad credentials" });
  if (request.method === "GET" && path === "/repos/acme/app") return reply(200, { private: true });
  // A second repo the token can see, to switch to.
  if (request.method === "GET" && path === "/repos/acme/next") return reply(200, { private: true });
  const one = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(path);
  if (request.method === "GET" && one) {
    const found = openedIssues.find((i) => i.number === Number(one[1]));
    if (!found) return reply(404, { message: "Not Found" });
    await duringStateCheck?.();
    if (stateFailures > 0) {
      stateFailures--;
      return reply(stateFailureStatus, { message: "refused" });
    }
    return reply(200, { state: found.state ?? "open", state_reason: found.state_reason ?? null });
  }
  if (request.method === "GET" && path === "/user") {
    if (userHidden) return reply(403, { message: "Resource not accessible by integration" });
    return reply(200, { login: botLogin });
  }
  const html = (number: number) => `https://github.com/acme/app/issues/${number}`;
  if (request.method === "POST" && path === "/repos/acme/app/issues") {
    if (rejectCreate) return reply(422, { message: "Validation Failed" });
    const number = nextIssue++;
    const { title, body } = JSON.parse(text) as { title: string; body: string };
    // GitHub stores bodies with CRLF line ends, which the lookup must see past.
    openedIssues.unshift({
      number,
      title,
      body: body.replaceAll("\n", "\r\n"),
      user: { login: botLogin },
      created_at: new Date().toISOString(),
    });
    await duringCreate?.();
    if (loseCreateAnswer) return reply(504, { message: "Gateway Timeout" });
    return reply(201, { number, html_url: html(number) });
  }
  if (request.method === "GET" && path === "/repos/acme/app/issues") {
    if (listLags) return reply(200, []);
    if (endlessList) {
      const now = new Date().toISOString();
      return reply(
        200,
        Array.from({ length: 50 }, (_, i) => ({
          number: 50_000 + i,
          title: "someone else's",
          body: "",
          user: { login: "someone" },
          created_at: now,
          html_url: html(50_000 + i),
        })),
      );
    }
    return reply(
      200,
      openedIssues.map((i) => ({ ...i, html_url: html(i.number), pull_request: undefined })),
    );
  }
  return reply(404, { message: "Not Found" });
};

const fakeGithub = octokitGithub({ baseUrl: "https://api.github.test", fetch: fakeGithubFetch });

// --- Emails out ---------------------------------------------------------------------------------

const sent: { from: string; to: string[]; raw: string }[] = [];
const transport: EmailTransport = {
  async send(message) {
    sent.push({ ...message, raw: new TextDecoder().decode(message.raw) });
  },
  close: () => {},
};

// --- Callers ------------------------------------------------------------------------------------

const allScopes: Scope[] = [
  "conversations:read",
  "conversations:write",
  "drafts:write",
  "drafts:approve",
  "knowledge:read",
  "knowledge:write",
  "github:write",
];
const principals: Record<string, () => Principal> = {
  owner: () => ({
    tenantId: acme,
    actor: { type: "user", id: "owner-user" },
    scopes: new Set([...allScopes, "workspace:admin"]),
  }),
  githubAgent: () => agent(acme, ["conversations:read", "github:write"]),
  // Can use the GitHub routes, but can't read conversations.
  githubOnly: () => agent(acme, ["github:write"]),
  // An agent can't hold workspace:admin, but even a caller claiming it as an agent is refused.
  adminAgent: () => agent(acme, [...allScopes, "workspace:admin"]),
  readOnly: () => agent(acme, ["conversations:read", "drafts:write", "drafts:approve"]),
  approver: () => agent(acme, ["conversations:read", "drafts:approve"]),
  otherOwner: () => ({
    tenantId: other,
    actor: { type: "user", id: "other-owner" },
    scopes: new Set([...allScopes, "workspace:admin"]),
  }),
};
function agent(tenantId: string, scopes: Scope[]): Principal {
  return { tenantId, actor: { type: "agent", id: "test-agent" }, scopes: new Set(scopes) };
}

function makeApp(
  overrides: {
    secretBox?: undefined;
    model?: LanguageModel | undefined;
    budget?: number;
    db?: Database;
    webhookSecretCacheMs?: number;
  } = {},
) {
  // The worker's services, with what this test changes.
  return createApp(
    {
      ...helpos.services,
      db: overrides.db ?? db,
      model: "model" in overrides ? overrides.model : issueModel,
      secretBox: "secretBox" in overrides ? undefined : box,
      config: {
        ...helpos.services.config,
        dailyTokenBudget: overrides.budget ?? helpos.services.config.dailyTokenBudget,
      },
    },
    {
      authenticate: async (req) => {
        const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        return principals[token]?.() ?? null;
      },
    },
  );
}
let app: ReturnType<typeof makeApp>;

function call(method: string, path: string, as: string | null, body?: object) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${as}`;
  return app.request(path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

let emailCount = 0;
async function receiveEmail(to = "support@acme.test", body = "Export to CSV shows an error.") {
  emailCount++;
  const raw = [
    "From: Jane Customer <jane@customer.test>",
    `To: ${to}`,
    `Subject: Export broken ${emailCount}`,
    `Message-ID: <export-${emailCount}@customer.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
  return { ...result, subject: `Export broken ${emailCount}` };
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

const draftsOf = (conversationId: string) =>
  db.withTenant(acme, (tx) =>
    tx
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.conversationId, conversationId))
      .orderBy(asc(schema.drafts.createdAt)),
  );
const auditActions = (tenantId: string, targetId: string) =>
  db
    .withTenant(tenantId, (tx) =>
      tx
        .select({ action: schema.auditEvents.action, actorId: schema.auditEvents.actorId })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, targetId))
        .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id)),
    )
    .then((rows) => rows.map((r) => r.action));

const auditRows = (targetId: string) =>
  db.withTenant(acme, (tx) =>
    tx
      .select({
        tenantId: schema.auditEvents.tenantId,
        actorType: schema.auditEvents.actorType,
        actorId: schema.auditEvents.actorId,
        requestId: schema.auditEvents.requestId,
        action: schema.auditEvents.action,
        targetType: schema.auditEvents.targetType,
        targetId: schema.auditEvents.targetId,
      })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, targetId))
      .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id)),
  );

/** Everything the server wrote to its logs and answered, as one string to search for secrets. */
const everythingLogged = () =>
  JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls]);

/** Connects acme/app as the owner and returns the webhook secret. */
async function connect(): Promise<string> {
  // A new secret on purpose: reconnecting the same repo otherwise keeps the old one.
  const res = await call("PUT", "/v1/integrations/github", "owner", {
    repo: "Acme/App",
    token: pat,
    rotateWebhookSecret: true,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { webhookSecret: string | null };
  if (!body.webhookSecret) throw new Error("connect: no new webhook secret");
  return body.webhookSecret;
}

async function createIssue(conversationId: string) {
  const res = await call(
    "POST",
    `/v1/conversations/${conversationId}/github-issue`,
    "githubAgent",
    {
      title: "Export fails",
      body: "Steps: open Reports.",
    },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { number: number; url: string };
}

/** A ping signed with a secret nobody has, to `app`, naming `workspace`. */
function forgedPing(target: { request: typeof app.request }, workspace: string) {
  const body = JSON.stringify({ zen: "hi" });
  return target.request(`/v1/integrations/github/webhook?workspace=${workspace}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": signWebhook("forged", body),
    },
    body,
  });
}

function deliver(
  secret: string,
  payload: object,
  options: { event?: string; workspace?: string; signature?: string | null } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": options.event ?? "issues",
    "x-github-delivery": crypto.randomUUID(),
  };
  const signature = options.signature === undefined ? signWebhook(secret, body) : options.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return app.request(`/v1/integrations/github/webhook?workspace=${options.workspace ?? acme}`, {
    method: "POST",
    headers,
    body,
  });
}

const closed = (
  number: number,
  stateReason: string | null = "completed",
  repo = "acme/App",
  updatedAt = new Date().toISOString(),
) => ({
  action: "closed",
  issue: {
    number,
    state: "closed",
    state_reason: stateReason,
    title: "ignored",
    updated_at: updatedAt,
  },
  repository: { full_name: repo },
  sender: { login: "octocat" },
});

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl, {
    sessions: {
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseUrl: "https://help.acme.test",
      cookiePrefix: "github-audit-test",
    },
  });
  helpos = composeServer({
    db,
    jobsUrl: testDb.jobsUrl,
    pollingIntervalSeconds: 0.5,
    onJobError: (error) => {
      throw error;
    },
    files,
    logger,
    model: mockModel({ text: replyText }),
    transport,
    secretBox: box,
    github: fakeGithub,
    config: {
      publicUrl: "https://help.acme.test/desk",
      noticeDelaySeconds: 3600,
      dailyTokenBudget: 1_000_000,
      issueRecheckSeconds: 0,
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
  app = makeApp();
});

beforeEach(() => {
  githubDown = false;
  loseCreateAnswer = false;
  listLags = false;
  rejectCreate = false;
  endlessList = false;
  userHidden = false;
  duringCreate = undefined;
  duringStateCheck = undefined;
  stateFailures = 0;
  stateFailureStatus = 503;
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

describe("connecting a repo", () => {
  it("is for a human admin only", async () => {
    const body = { repo: "acme/app", token: pat };
    expect((await call("PUT", "/v1/integrations/github", null, body)).status).toBe(401);
    expect((await call("PUT", "/v1/integrations/github", "githubAgent", body)).status).toBe(403);
    expect((await call("PUT", "/v1/integrations/github", "adminAgent", body)).status).toBe(403);
    expect((await call("DELETE", "/v1/integrations/github", "githubAgent")).status).toBe(403);
    expect(githubCalls).toHaveLength(0);
  });

  it("refuses a token GitHub rejects, or a repo it can't see, and stores nothing", async () => {
    const rejected = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/app",
      token: badPat,
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ error: "token_rejected" });
    const missing = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/nope",
      token: pat,
    });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toEqual({ error: "repo_not_found" });
    githubDown = true;
    const down = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/app",
      token: pat,
    });
    expect(down.status).toBe(502);
    const rows = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
    expect(rows).toEqual([]);
  });

  it("refuses something that isn't a GitHub token or a repo name, without echoing it", async () => {
    const res = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/app",
      token: "not-a-token-but-a-secret-1234",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("not-a-token-but-a-secret-1234");
    const repo = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "../etc",
      token: pat,
    });
    expect(repo.status).toBe(400);
    // A classic token reaches every repo its owner can: only fine-grained tokens are taken.
    const classic = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    const refused = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/app",
      token: classic,
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain(classic);
    expect(githubCalls.some((c) => c.authorization === `token ${classic}`)).toBe(false);
  });

  it("refuses to store a token when the server has no encryption key", async () => {
    app = makeApp({ secretBox: undefined });
    try {
      const res = await call("PUT", "/v1/integrations/github", "owner", {
        repo: "acme/app",
        token: pat,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "encryption_not_configured" });
    } finally {
      app = makeApp();
    }
  });

  it("stores the token encrypted, never returns it, and shows the webhook secret once", async () => {
    const res = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "Acme/App",
      token: pat,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(pat);
    const body = JSON.parse(text) as Record<string, string>;
    expect(body).toMatchObject({
      connected: true,
      repo: "acme/app",
      webhookUrl: `https://help.acme.test/desk/v1/integrations/github/webhook?workspace=${acme}`,
    });
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

    // The token was checked with GitHub, sent only in the Authorization header.
    // Then its own account, which finding a lost issue relies on.
    expect(githubCalls.slice(-2)).toMatchObject([
      { method: "GET", path: "/repos/acme/app", authorization: `token ${pat}` },
      { method: "GET", path: "/user", authorization: `token ${pat}` },
    ]);

    // At rest: only ciphertext, bound to this workspace.
    const [row] = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
    if (!row) throw new Error("no integration row");
    expect(JSON.stringify(row)).not.toContain(pat);
    expect(JSON.stringify(row)).not.toContain(body.webhookSecret);
    expect(box.open(row.tokenCiphertext, { tenantId: acme, purpose: "github-token" })).toBe(pat);
    expect(() =>
      box.open(row.tokenCiphertext, { tenantId: other, purpose: "github-token" }),
    ).toThrow();
    expect(await auditActions(acme, row.id)).toEqual(["github.connected"]);

    // Reading it back never shows the token or the secret.
    const read = await call("GET", "/v1/integrations/github", "githubAgent");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      connected: true,
      repo: "acme/app",
      webhookUrl: body.webhookUrl,
    });
    expect((await call("GET", "/v1/integrations/github", "readOnly")).status).toBe(403);
    // Another workspace sees its own (empty) connection, never Acme's.
    expect(await (await call("GET", "/v1/integrations/github", "otherOwner")).json()).toEqual({
      connected: false,
      repo: null,
      webhookUrl: null,
    });
    expect(everythingLogged()).not.toContain(pat);
  });
  it("keeps the webhook secret when the same repo is connected again, unless asked", async () => {
    const stored = async () => {
      const [row] = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
      if (!row) throw new Error("not connected");
      return box.open(row.webhookSecretCiphertext, {
        tenantId: acme,
        purpose: "github-webhook-secret",
      });
    };
    const put = (body: object) => call("PUT", "/v1/integrations/github", "owner", body);
    const first = await stored();
    // A new token for the same repo: the webhook already set up in GitHub keeps working.
    const again = await put({ repo: "acme/app", token: pat });
    expect(await again.json()).toMatchObject({ connected: true, webhookSecret: null });
    expect(await stored()).toBe(first);
    // Asked for: a new one, shown once.
    const rotated = (await (
      await put({ repo: "acme/app", token: pat, rotateWebhookSecret: true })
    ).json()) as {
      webhookSecret: string;
    };
    expect(rotated.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(await stored()).toBe(rotated.webhookSecret);
    // Another repo needs a webhook of its own, so it gets a new secret too.
    const moved = (await (await put({ repo: "acme/next", token: pat })).json()) as {
      webhookSecret: string;
    };
    expect(moved.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(moved.webhookSecret).not.toBe(rotated.webhookSecret);
    expect((await put({ repo: "acme/app", token: pat })).status).toBe(200);
  });

  it("gives a new webhook secret when the stored one can't be read, even for the same repo", async () => {
    // As if the server's key changed: the stored secret is sealed under another key.
    const oldKey = createSecretBox(randomBytes(32));
    const sealed = oldKey.seal("lost", { tenantId: acme, purpose: "github-webhook-secret" });
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.integrations)
        .set({ webhookSecretCiphertext: sealed })
        .where(eq(schema.integrations.provider, "github")),
    );
    const res = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/app",
      token: pat,
    });
    const { webhookSecret } = (await res.json()) as { webhookSecret: string | null };
    // Reconnecting is what the webhook's warning says to do, so it has to mend the webhook.
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
    expect(
      box.open(row?.webhookSecretCiphertext ?? "", {
        tenantId: acme,
        purpose: "github-webhook-secret",
      }),
    ).toBe(webhookSecret);
  });

  it("lets two first connects at once both succeed, with one row and one secret", async () => {
    expect((await call("DELETE", "/v1/integrations/github", "owner")).status).toBe(204);
    const put = () =>
      call("PUT", "/v1/integrations/github", "owner", { repo: "acme/app", token: pat });
    const answers = await Promise.all([put(), put()]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    const secrets = await Promise.all(
      answers.map(
        async (r) => ((await r.json()) as { webhookSecret: string | null }).webhookSecret,
      ),
    );
    // One made the secret; the other, for the same repo, kept it.
    const made = secrets.filter((s) => s !== null);
    expect(made).toHaveLength(1);
    const rows = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
    expect(rows).toHaveLength(1);
    expect(
      box.open(rows[0]?.webhookSecretCiphertext ?? "", {
        tenantId: acme,
        purpose: "github-webhook-secret",
      }),
    ).toBe(made[0]);
  });

  it("refuses a token that can't read its own account, which finding a lost issue needs", async () => {
    userHidden = true;
    const res = await call("PUT", "/v1/integrations/github", "owner", {
      repo: "acme/app",
      token: pat,
      rotateWebhookSecret: true,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "token_rejected" });
  });

  it("gives the webhook a new secret without the token, for a human admin only", async () => {
    const old = await connect();
    const rotate = (as: string) => call("POST", "/v1/integrations/github/webhook-secret", as);
    expect((await rotate("adminAgent")).status).toBe(403);
    const res = await rotate("owner");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { webhookSecret } = (await res.json()) as { webhookSecret: string };
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    // The old secret stops working at once; the new one works; the token is untouched.
    const ping = { zen: "hi", hook_id: 1 };
    expect((await deliver(old, ping, { event: "ping" })).status).toBe(401);
    expect((await deliver(webhookSecret, ping, { event: "ping" })).status).toBe(200);
    const [row] = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
    expect(box.open(row?.tokenCiphertext ?? "", { tenantId: acme, purpose: "github-token" })).toBe(
      pat,
    );
    expect(await auditActions(acme, row?.id ?? "")).toContain("github.webhook_secret_rotated");
    expect(everythingLogged()).not.toContain(webhookSecret);
    // Nothing connected: nothing to rotate.
    expect(
      (await call("POST", "/v1/integrations/github/webhook-secret", "otherOwner")).status,
    ).toBe(404);
  });
});

describe("drafting an issue with the AI", () => {
  it("suggests a cleaned-up issue from the conversation, counted against the budget", async () => {
    const email = await receiveEmail("support@acme.test", "Export fails. Assign @ceo, label P0!");
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue/draft`,
      "githubAgent",
    );
    expect(res.status).toBe(200);
    const draft = (await res.json()) as { title: string; body: string };
    expect(draft.title).toBe("Export fails for `@boss`");
    expect(draft.body).toContain("See [link removed] and `#1`.");
    expect(draft.body).toContain("1. Open Reports\n2. Click Export CSV");
    // The customer's text reached the model only as quoted data.
    const prompt = JSON.stringify(issueModel.doGenerateCalls.at(-1)?.prompt);
    expect(prompt).toMatch(/<untrusted_email>.*Assign @ceo, label P0!.*<\/untrusted_email>/);

    const [usage] = await db.withTenant(acme, (tx) => tx.select().from(schema.aiUsage));
    expect(usage).toMatchObject({ inputTokens: 300, outputTokens: 100 });
    expect(await auditActions(acme, email.conversationId)).toContain("github_issue.drafted");
  });

  it("reserves the budget up front, so concurrent drafts can't both pass the cap", async () => {
    // Another workspace, so its usage starts at zero.
    const email = await receiveEmail("help@other.test");
    const path = `/v1/conversations/${email.conversationId}/github-issue/draft`;
    const usage = () =>
      db.withTenant(other, async (tx) => (await tx.select().from(schema.aiUsage))[0]);
    let second = 0;
    let secondError = "";
    app = makeApp({
      model: mockModel({
        text: JSON.stringify(issueJson),
        usage: { inputTokens: 300, outputTokens: 100 },
        // While this draft is in flight, leave no room above its reservation, then ask again.
        pause: async () => {
          // Held apart from the spend until the call settles.
          expect(await usage()).toMatchObject({ inputTokens: 0, calls: 0 });
          const reserved = (await usage())?.reservedTokens ?? 0;
          expect(reserved).toBeGreaterThan(300);
          await db.withTenant(other, (tx) =>
            tx
              .update(schema.tenants)
              .set({ aiDailyTokenBudget: reserved })
              .where(eq(schema.tenants.id, other)),
          );
          const res = await call("POST", path, "otherOwner");
          second = res.status;
          secondError = ((await res.json()) as { error: string }).error;
        },
      }),
    });
    try {
      expect((await call("POST", path, "otherOwner")).status).toBe(200);
      // Nothing is spent yet, but the call in flight holds the rest: try again shortly.
      expect([second, secondError]).toEqual([503, "ai_busy"]);
      // The reservation became the real cost: one call, 300 in, 100 out.
      expect(await usage()).toMatchObject({
        inputTokens: 300,
        outputTokens: 100,
        calls: 1,
        reservedTokens: 0,
      });

      // A failure whose cost can't be told keeps its reservation counted: the budget may
      // overcount, never undercount. (Which failures are free is unit-tested in @helpos/ai.)
      await db.withTenant(other, (tx) =>
        tx
          .update(schema.tenants)
          .set({ aiDailyTokenBudget: null })
          .where(eq(schema.tenants.id, other)),
      );
      app = makeApp({ model: failingModel() });
      expect((await call("POST", path, "otherOwner")).status).toBe(502);
      const after = await usage();
      expect(after).toMatchObject({ outputTokens: 100, calls: 2, reservedTokens: 0 });
      expect(after?.inputTokens).toBeGreaterThan(300 + 2_000);
    } finally {
      app = makeApp();
    }
  });

  it("still answers ai_unavailable when the failed call's cost can't be written back", async () => {
    const email = await receiveEmail();
    // Fails every transaction after the one that reserves the budget: the settle, here.
    let calls = 0;
    const flaky: Database = {
      ...db,
      withTenant: (tenantId, fn) =>
        ++calls > 1 ? Promise.reject(new Error("pool timeout")) : db.withTenant(tenantId, fn),
    };
    try {
      app = makeApp({ model: refusingModel(), db: flaky });
      const res = await call(
        "POST",
        `/v1/conversations/${email.conversationId}/github-issue/draft`,
        "owner",
      );
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "ai_unavailable" });
      expect(JSON.stringify(logger.warn.mock.calls)).toContain("usage not settled");
    } finally {
      app = makeApp();
    }
  });

  it("holds no lock while the AI writes, so reply drafting never waits on it", async () => {
    const email = await receiveEmail();
    let lockedMeanwhile = false;
    app = makeApp({
      model: mockModel({
        text: JSON.stringify(issueJson),
        // While the model "thinks", reserve from the same usage row, with a short timeout:
        // its lock must be free.
        pause: async () => {
          const budget = aiBudget({
            clock: systemClock,
            config: { dailyTokenBudget: 1e9 },
            logger,
          });
          await db.withTenant(acme, async (tx) => {
            await tx.execute(sql`set local lock_timeout = '2s'`);
            await budget.reserve(tx, acme, 0);
          });
          lockedMeanwhile = true;
        },
      }),
    });
    try {
      const res = await call(
        "POST",
        `/v1/conversations/${email.conversationId}/github-issue/draft`,
        "githubAgent",
      );
      expect(res.status).toBe(200);
      expect(lockedMeanwhile).toBe(true);
    } finally {
      app = makeApp();
    }
  });

  it("needs github:write, a model, budget left, and a conversation in this workspace", async () => {
    const email = await receiveEmail();
    const path = `/v1/conversations/${email.conversationId}/github-issue/draft`;
    expect((await call("POST", path, "readOnly")).status).toBe(403);
    expect((await call("POST", path, "otherOwner")).status).toBe(404);
    app = makeApp({ model: undefined });
    expect((await call("POST", path, "githubAgent")).status).toBe(503);
    app = makeApp({ budget: 0 });
    const spent = await call("POST", path, "githubAgent");
    expect(spent.status).toBe(409);
    expect(await spent.json()).toEqual({ error: "daily_budget_reached" });
    app = makeApp();
  });
});

describe("creating the issue", () => {
  it("sends only the title and body, and links the issue to the conversation", async () => {
    const email = await receiveEmail();
    const before = githubCalls.length;
    const issue = await createIssue(email.conversationId);
    expect(issue.url).toBe(`https://github.com/acme/app/issues/${issue.number}`);

    // One create, then one read of its state (it could have been closed already).
    const posted = githubCalls.slice(before);
    expect(posted.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(posted[0]).toMatchObject({
      method: "POST",
      path: "/repos/acme/app/issues",
      authorization: `token ${pat}`,
    });
    // Exactly these two fields: no labels, assignees or milestone can ride along.
    expect(Object.keys(posted[0]?.body as object).sort()).toEqual(["body", "title"]);
    // The body as written, then only the hidden line that lets a lost answer be recovered.
    expect(posted[0]?.body).toEqual({
      title: "Export fails",
      body: expect.stringMatching(
        /^Steps: open Reports\.\n\n<!-- helpdesk-claim:[0-9a-f-]{36} -->$/,
      ),
    });

    const conversation = await call("GET", `/v1/conversations/${email.conversationId}`, "readOnly");
    expect(await conversation.json()).toMatchObject({
      githubIssue: { repo: "acme/app", number: issue.number, url: issue.url, state: "open" },
    });
    expect(await auditActions(acme, email.conversationId)).toContain("github_issue.created");

    // One issue per conversation.
    const again = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "Again",
        body: "",
      },
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_linked" });
  });

  it("refuses extra fields such as labels or assignees", async () => {
    const email = await receiveEmail();
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
        labels: ["P0"],
        assignees: ["ceo"],
      },
    );
    expect(res.status).toBe(400);
  });

  it("links nothing when GitHub refuses, so it can be tried again at once", async () => {
    const email = await receiveEmail();
    rejectCreate = true;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    // GitHub's 422: the issue itself was refused, so "try again later" would never help.
    expect(JSON.parse(text)).toEqual({ error: "issue_rejected" });
    expect(text).not.toContain(pat);
    rejectCreate = false;
    await createIssue(email.conversationId);
    expect(everythingLogged()).not.toContain(pat);
  });

  it("holds the conversation when GitHub is down, since a 5xx may come after the issue was opened", async () => {
    const email = await receiveEmail();
    githubDown = true;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "github_outcome_unknown" });
    expect(text).not.toContain(pat);
    expect(everythingLogged()).not.toContain(pat);
  });

  it("finds the issue when GitHub opened it but its answer was lost, instead of opening another", async () => {
    const email = await receiveEmail();
    loseCreateAnswer = true;
    const before = githubCalls.length;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "Lost answer",
        body: "Line one\nLine two",
      },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const linked = (await res.json()) as { number: number };
    const calls = githubCalls.slice(before).map((c) => `${c.method} ${c.path}`);
    // One create, then a lookup, then its state: never a second create.
    expect(calls).toEqual([
      "POST /repos/acme/app/issues",
      "GET /user",
      "GET /repos/acme/app/issues",
      `GET /repos/acme/app/issues/${openedIssues[0]?.number}`,
    ]);
    expect(linked.number).toBe(openedIssues[0]?.number);
    expect(
      await (await call("GET", `/v1/conversations/${email.conversationId}`, "readOnly")).json(),
    ).toMatchObject({
      githubIssue: { number: linked.number, state: "open" },
    });
  });

  it("finds a retry's own issue too, when a stale claim had none and the retry's answer is lost", async () => {
    const email = await receiveEmail();
    // A claim from a request that died before GitHub opened anything.
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/app",
        state: "creating",
        createdAt: longAgo,
        updatedAt: longAgo,
      }),
    );
    loseCreateAnswer = true;
    const before = githubCalls.length;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const opened = openedIssues[0]?.number;
    expect(githubCalls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      // The stale claim's marker: not there.
      "GET /user",
      "GET /repos/acme/app/issues",
      // Opened, but the answer is lost.
      "POST /repos/acme/app/issues",
      // This claim's own marker: found, so nothing is opened twice.
      "GET /user",
      "GET /repos/acme/app/issues",
      `GET /repos/acme/app/issues/${opened}`,
    ]);
    expect(((await res.json()) as { number: number }).number).toBe(opened);
  });

  it("never links an issue that another conversation already links", async () => {
    const first = await receiveEmail();
    const email = await receiveEmail();
    const link = (conversationId: string, number: number) => ({
      tenantId: acme,
      conversationId,
      repo: "acme/app",
      issueNumber: number,
      issueUrl: `https://github.com/acme/app/issues/${number}`,
      state: "open" as const,
    });
    // The issue GitHub just opened is, somehow, already another conversation's.
    duringCreate = () =>
      db.withTenant(acme, async (tx) => {
        const opened = openedIssues[0];
        if (!opened) throw new Error("no issue opened");
        await tx
          .insert(schema.conversationGithubIssues)
          .values(link(first.conversationId, opened.number));
      });
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    // Its "fixed" notice belongs to the first conversation's customer alone.
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "issue_not_linked" });
    // This conversation's claim is released, so it isn't held only to find that same issue again.
    duringCreate = undefined;
    const retry = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(retry.status, await retry.clone().text()).toBe(201);
    // The database refuses a second link outright, too.
    const third = await receiveEmail();
    const number = openedIssues[1]?.number ?? 0;
    await expect(
      db.withTenant(acme, (tx) =>
        tx.insert(schema.conversationGithubIssues).values(link(third.conversationId, number)),
      ),
    ).rejects.toThrow();
  });

  it("reads the state again later when it can't be read right after linking", async () => {
    await connect();
    const email = await receiveEmail();
    // Closed the moment it exists, and GitHub fails the check after linking and the first
    // recheck: the worker keeps trying, and the close is applied when GitHub answers.
    duringCreate = async () => {
      const opened = openedIssues[0];
      if (opened) Object.assign(opened, { state: "closed", state_reason: "completed" });
    };
    stateFailures = 2;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ state: "open" });
    const fixed = await waitFor("the recheck's fixed draft", async () => {
      const drafts = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
      return drafts.length > 0 ? drafts : undefined;
    });
    expect(fixed).toHaveLength(1);
    expect(stateFailures).toBe(0);
    expect.soft(await auditRows(email.conversationId)).toContainEqual({
      tenantId: acme,
      actorType: "system",
      actorId: "github-recheck",
      requestId: null,
      action: "github_issue.closed",
      targetType: "conversation",
      targetId: email.conversationId,
    });
    expect(await auditRows(fixed[0]?.id ?? "")).toEqual([
      {
        tenantId: acme,
        actorType: "system",
        actorId: "github-recheck",
        requestId: null,
        action: "draft.created",
        targetType: "draft",
        targetId: fixed[0]?.id,
      },
    ]);
    expect(
      await (await call("GET", `/v1/conversations/${email.conversationId}`, "readOnly")).json(),
    ).toMatchObject({ githubIssue: { state: "closed" } });
  });

  it("attributes an expired recheck to the job when GitHub stays unavailable", async () => {
    await connect();
    const email = await receiveEmail();
    duringStateCheck = async () => {
      await db.withTenant(acme, (tx) =>
        tx
          .update(schema.conversationGithubIssues)
          .set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
          .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId)),
      );
    };
    stateFailures = 2;
    await createIssue(email.conversationId);
    await expect
      .poll(() => auditRows(email.conversationId), { timeout: 20_000 })
      .toContainEqual({
        tenantId: acme,
        actorType: "system",
        actorId: "github-recheck",
        requestId: null,
        action: "github_issue.recheck_failed",
        targetType: "conversation",
        targetId: email.conversationId,
      });
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toEqual([]);
  });

  it("says what GitHub said when a stale claim's search is refused, not 'unavailable'", async () => {
    const email = await receiveEmail();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/app",
        state: "creating",
        createdAt: longAgo,
        updatedAt: longAgo,
      }),
    );
    // The token lost access: retrying won't help, fixing the token will.
    userHidden = true;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "token_rejected" });
  });

  it("doesn't block a conversation on a stale claim in a repo the token can no longer see", async () => {
    const email = await receiveEmail();
    // A claim from before the workspace switched repos; this token can't see that one at all.
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/gone",
        state: "creating",
        createdAt: longAgo,
        updatedAt: longAgo,
      }),
    );
    const posts = () => githubCalls.filter((c) => c.method === "POST").length;
    const before = posts();
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await res.json()).toMatchObject({ repo: "acme/app", number: openedIssues[0]?.number });
    expect(posts() - before).toBe(1);
  });

  it("keeps rechecking after a refusal an admin can fix, such as an expired token", async () => {
    const email = await receiveEmail();
    duringCreate = async () => {
      const opened = openedIssues[0];
      if (opened) Object.assign(opened, { state: "closed", state_reason: "completed" });
    };
    // GitHub refuses the token for the check after linking and for the first recheck.
    stateFailureStatus = 401;
    stateFailures = 2;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    const fixed = await waitFor("the recheck's fixed draft", async () => {
      const drafts = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
      return drafts.length > 0 ? drafts : undefined;
    });
    expect(fixed).toHaveLength(1);
  });

  it("keeps a stale claim, and so its marker, even if making it stale again fails", async () => {
    const email = await receiveEmail();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    const [stale] = await db.withTenant(acme, (tx) =>
      tx
        .insert(schema.conversationGithubIssues)
        .values({
          tenantId: acme,
          conversationId: email.conversationId,
          repo: "acme/app",
          state: "creating",
          createdAt: longAgo,
          updatedAt: longAgo,
        })
        .returning(),
    );
    // GitHub is down for the search, and the database fails the write after the claim.
    githubDown = true;
    let calls = 0;
    const flaky: Database = {
      ...db,
      withTenant: (tenantId, fn) =>
        ++calls === 2 ? Promise.reject(new Error("pool timeout")) : db.withTenant(tenantId, fn),
    };
    try {
      app = makeApp({ db: flaky });
      const res = await call(
        "POST",
        `/v1/conversations/${email.conversationId}/github-issue`,
        "githubAgent",
        {
          title: "t",
          body: "b",
        },
      );
      expect(res.status).toBe(502);
    } finally {
      app = makeApp();
    }
    // Taken over in place: the same claim, so its marker is still the one searched for.
    const [claim] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.conversationGithubIssues)
        .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId)),
    );
    expect(claim?.id).toBe(stale?.id);
    expect(claim?.state).toBe("creating");
  });

  it("keeps a recheck waiting while the repo is being reconnected, instead of dropping it", async () => {
    const email = await receiveEmail();
    duringCreate = async () => {
      const opened = openedIssues[0];
      if (opened) Object.assign(opened, { state: "closed", state_reason: "completed" });
    };
    // GitHub fails the check after linking, and the connection is gone a moment: the recheck
    // finds no token to ask with.
    const [saved] = await db.withTenant(acme, (tx) => tx.select().from(schema.integrations));
    if (!saved) throw new Error("not connected");
    duringStateCheck = async () => {
      duringStateCheck = undefined;
      stateFailures = 1;
      await db.withTenant(acme, (tx) => tx.delete(schema.integrations));
    };
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    await waitFor("the recheck to wait", async () =>
      JSON.stringify(logger.warn.mock.calls).includes("github recheck: waiting") ? true : undefined,
    );
    // Connected again: the waiting recheck applies the close.
    await db.withTenant(acme, (tx) => tx.insert(schema.integrations).values(saved));
    const fixed = await waitFor("the recheck's fixed draft", async () => {
      const drafts = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
      return drafts.length > 0 ? drafts : undefined;
    });
    expect(fixed).toHaveLength(1);
  });

  it("answers 201 when the issue is linked, even if applying its close then fails", async () => {
    const email = await receiveEmail();
    duringCreate = async () => {
      const opened = openedIssues[0];
      if (opened) Object.assign(opened, { state: "closed", state_reason: "completed" });
    };
    // The transaction that applies the close fails; the worker applies it instead.
    let failNext = false;
    duringStateCheck = async () => {
      failNext = true;
    };
    const flaky: Database = {
      ...db,
      withTenant: (tenantId, fn) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("pool timeout"));
        }
        return db.withTenant(tenantId, fn);
      },
    };
    try {
      app = makeApp({ db: flaky });
      const res = await call(
        "POST",
        `/v1/conversations/${email.conversationId}/github-issue`,
        "githubAgent",
        {
          title: "t",
          body: "b",
        },
      );
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await res.json()).toMatchObject({ state: "open" });
      const fixed = await waitFor("the recheck's fixed draft", async () => {
        const drafts = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
        return drafts.length > 0 ? drafts : undefined;
      });
      expect(fixed).toHaveLength(1);
    } finally {
      app = makeApp();
    }
  });

  it("opens one issue when two requests take over the same stale claim at once", async () => {
    const email = await receiveEmail();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/app",
        state: "creating",
        createdAt: longAgo,
        updatedAt: longAgo,
      }),
    );
    const posts = () => githubCalls.filter((c) => c.method === "POST").length;
    const before = posts();
    const path = `/v1/conversations/${email.conversationId}/github-issue`;
    const answers = await Promise.all([
      call("POST", path, "githubAgent", { title: "t", body: "b" }),
      call("POST", path, "githubAgent", { title: "t", body: "b" }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(posts() - before).toBe(1);
  });

  it("still links the issue when this request's claim was taken as stale meanwhile", async () => {
    const email = await receiveEmail();
    duringCreate = () =>
      db.withTenant(acme, async (tx) => {
        await tx
          .delete(schema.conversationGithubIssues)
          .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId));
      });
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    expect(await auditActions(acme, email.conversationId)).toContain("github_issue.created");
  });

  it("gives the issue's address when it was opened but can't be linked", async () => {
    const email = await receiveEmail();
    // Another request claimed the conversation while GitHub was opening this one's issue.
    duringCreate = () =>
      db.withTenant(acme, async (tx) => {
        await tx
          .delete(schema.conversationGithubIssues)
          .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId));
        await tx.insert(schema.conversationGithubIssues).values({
          tenantId: acme,
          conversationId: email.conversationId,
          repo: "acme/app",
          state: "creating",
        });
      });
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(500);
    const opened = openedIssues[0]?.number;
    expect(await res.json()).toEqual({
      error: "issue_not_linked",
      url: `https://github.com/acme/app/issues/${opened}`,
    });
    // The log names the orphan, so it can be found and closed.
    expect(JSON.stringify(logger.error.mock.calls)).toContain(`"issue":${opened}`);
  });

  it("never opens a second issue when GitHub's answer is lost and the issue isn't listed yet", async () => {
    const email = await receiveEmail();
    const path = `/v1/conversations/${email.conversationId}/github-issue`;
    const posts = () => githubCalls.filter((c) => c.method === "POST").length;
    const before = posts();
    loseCreateAnswer = true;
    listLags = true;
    const lost = await call("POST", path, "githubAgent", { title: "t", body: "b" });
    expect(lost.status).toBe(502);
    expect(await lost.json()).toEqual({ error: "github_outcome_unknown" });
    // The claim stays: a retry now is refused instead of opening a second issue.
    loseCreateAnswer = false;
    listLags = false;
    const retry = await call("POST", path, "githubAgent", { title: "t", body: "b" });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "creation_pending" });
    // Once the claim is stale, the next try finds the earlier issue by its marker.
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.conversationGithubIssues)
        .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId)),
    );
    const later = await call("POST", path, "githubAgent", { title: "t", body: "b" });
    expect(later.status, await later.clone().text()).toBe(201);
    expect(((await later.json()) as { number: number }).number).toBe(openedIssues[0]?.number);
    expect(posts() - before).toBe(1);
  });

  it("keeps a stale claim's marker searchable when GitHub is down while it's looked for", async () => {
    const email = await receiveEmail();
    const path = `/v1/conversations/${email.conversationId}/github-issue`;
    const posts = () => githubCalls.filter((c) => c.method === "POST").length;
    const claimOf = async () =>
      (
        await db.withTenant(acme, (tx) =>
          tx
            .select()
            .from(schema.conversationGithubIssues)
            .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId)),
        )
      )[0];
    const before = posts();
    loseCreateAnswer = true;
    listLags = true;
    expect((await call("POST", path, "githubAgent", { title: "t", body: "b" })).status).toBe(502);
    const first = await claimOf();
    loseCreateAnswer = false;
    listLags = false;
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.conversationGithubIssues)
        .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId)),
    );
    // GitHub is down while the stale claim's issue is looked for: that claim comes back.
    githubDown = true;
    const down = await call("POST", path, "githubAgent", { title: "t", body: "b" });
    expect(down.status).toBe(502);
    expect((await claimOf())?.id).toBe(first?.id);
    // GitHub is back: the earlier issue is found by its marker, not opened again.
    githubDown = false;
    const back = await call("POST", path, "githubAgent", { title: "t", body: "b" });
    expect(back.status, await back.clone().text()).toBe(201);
    expect(((await back.json()) as { number: number }).number).toBe(openedIssues[0]?.number);
    expect(posts() - before).toBe(1);
  });

  it("adopts only its own issue when someone copied the marker into theirs", async () => {
    const email = await receiveEmail();
    loseCreateAnswer = true;
    // Someone who can read the repo copies the hidden marker into a newer issue of their own.
    duringCreate = async () => {
      const ours = openedIssues[0];
      if (!ours) throw new Error("no issue opened");
      openedIssues.unshift({ ...ours, number: 9_999, user: { login: "mallory" } });
    };
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    const linked = ((await res.json()) as { number: number }).number;
    expect(linked).not.toBe(9_999);
    expect(linked).toBe(openedIssues.find((i) => i.user.login === botLogin)?.number);
  });

  it("counts a link an earlier attempt already committed as success, not a clash", async () => {
    const email = await receiveEmail();
    // As if the first try to record the link committed but its answer never came back.
    duringCreate = () =>
      db.withTenant(acme, async (tx) => {
        const opened = openedIssues[0];
        if (!opened) throw new Error("no issue opened");
        await tx
          .update(schema.conversationGithubIssues)
          .set({
            state: "open",
            issueNumber: opened.number,
            issueUrl: `https://github.com/acme/app/issues/${opened.number}`,
          })
          .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId));
      });
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { number: number }).number).toBe(openedIssues[0]?.number);
  });

  it("cleans an agent's text like an AI draft, and sends a person's as written", async () => {
    const written = { title: "Ping @ceo", body: "See torvalds/linux#1 and https://evil.test." };
    const agentConversation = (await receiveEmail()).conversationId;
    const before = githubCalls.length;
    expect(
      (
        await call(
          "POST",
          `/v1/conversations/${agentConversation}/github-issue`,
          "githubAgent",
          written,
        )
      ).status,
    ).toBe(201);
    const fromAgent = githubCalls.slice(before).find((c) => c.method === "POST")?.body as {
      title: string;
      body: string;
    };
    expect(fromAgent.title).toBe("Ping `@ceo`");
    expect(fromAgent.body).toMatch(/^See `torvalds\/linux#1` and \[link removed\]\./);

    const personConversation = (await receiveEmail()).conversationId;
    const mid = githubCalls.length;
    expect(
      (await call("POST", `/v1/conversations/${personConversation}/github-issue`, "owner", written))
        .status,
    ).toBe(201);
    const fromPerson = githubCalls.slice(mid).find((c) => c.method === "POST")?.body as {
      title: string;
      body: string;
    };
    expect(fromPerson.title).toBe(written.title);
    expect(fromPerson.body.startsWith(written.body)).toBe(true);
  });

  it.each(["user", "agent"] as const)(
    "attributes an early close to the authenticated %s request",
    async (actorType) => {
      await connect();
      const api = createApp({ ...helpos.services, auth });
      const owner = await auth.ensureUser("owner@acme.test");
      const { token } = await auth.issueSetupToken(owner.id);
      const password = "github audit test password";
      const origin = "https://help.acme.test";
      const setup = await api.request("/v1/auth/password", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      expect(setup.status).toBe(204);
      const signIn = await api.request("/v1/auth/sign-in", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: owner.email, password }),
      });
      expect(signIn.status).toBe(204);
      const headers: Record<string, string> = {
        origin,
        "content-type": "application/json",
        cookie: signIn.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; "),
      };
      let actorId = owner.id;
      if (actorType === "agent") {
        const minted = await api.request("/v1/tokens", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "github-audit",
            scopes: ["conversations:read", "github:write"],
          }),
        });
        expect(minted.status).toBe(201);
        const credential = (await minted.json()) as { id: string; token: string };
        actorId = credential.id;
        delete headers.cookie;
        headers.authorization = `Bearer ${credential.token}`;
      }
      const email = await receiveEmail();
      duringCreate = async () => {
        const opened = openedIssues[0];
        if (opened) Object.assign(opened, { state: "closed", state_reason: "completed" });
      };
      const res = await api.request(`/v1/conversations/${email.conversationId}/github-issue`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "t", body: "b" }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ state: "closed" });
      const fixed = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
      expect(fixed).toHaveLength(1);
      const detail = await api.request(`/v1/conversations/${email.conversationId}`, { headers });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ githubIssue: { state: "closed" } });
      const draftList = await api.request(`/v1/conversations/${email.conversationId}/drafts`, {
        headers,
      });
      expect(draftList.status).toBe(200);
      expect(await draftList.json()).toMatchObject({
        drafts: expect.arrayContaining([
          expect.objectContaining({ kind: "fixed", status: "pending", body: fixedNoticeBody }),
        ]),
      });
      const context = {
        tenantId: acme,
        actorType,
        actorId,
        requestId: res.headers.get("x-request-id"),
      };
      expect(context.requestId).toBeTruthy();
      expect.soft(await auditRows(email.conversationId)).toEqual([
        {
          ...context,
          action: "github_issue.created",
          targetType: "conversation",
          targetId: email.conversationId,
        },
        {
          ...context,
          action: "github_issue.closed",
          targetType: "conversation",
          targetId: email.conversationId,
        },
      ]);
      expect(await auditRows(fixed[0]?.id ?? "")).toEqual([
        { ...context, action: "draft.created", targetType: "draft", targetId: fixed[0]?.id },
      ]);
    },
  );

  it("calls an endless issue list 'don't know', never 'not there'", async () => {
    const email = await receiveEmail();
    loseCreateAnswer = true;
    endlessList = true;
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "github_outcome_unknown" });
  });

  it("links an earlier claim's issue under its own repo after the workspace switched repos", async () => {
    const email = await receiveEmail();
    const path = `/v1/conversations/${email.conversationId}/github-issue`;
    loseCreateAnswer = true;
    listLags = true;
    expect((await call("POST", path, "githubAgent", { title: "t", body: "b" })).status).toBe(502);
    loseCreateAnswer = false;
    listLags = false;
    try {
      // The workspace moves to another repo while that claim waits.
      const moved = await call("PUT", "/v1/integrations/github", "owner", {
        repo: "acme/next",
        token: pat,
      });
      expect(moved.status).toBe(200);
      await db.withTenant(acme, (tx) =>
        tx
          .update(schema.conversationGithubIssues)
          .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
          .where(eq(schema.conversationGithubIssues.conversationId, email.conversationId)),
      );
      const res = await call("POST", path, "githubAgent", { title: "t", body: "b" });
      expect(res.status, await res.clone().text()).toBe(201);
      expect(await res.json()).toMatchObject({ repo: "acme/app", number: openedIssues[0]?.number });
      const conversation = await (
        await call("GET", `/v1/conversations/${email.conversationId}`, "readOnly")
      ).json();
      expect(conversation).toMatchObject({ githubIssue: { repo: "acme/app" } });
    } finally {
      await call("PUT", "/v1/integrations/github", "owner", { repo: "acme/app", token: pat });
    }
  });

  it("asks for credentials on both issue routes", async () => {
    const email = await receiveEmail();
    expect(
      (
        await call("POST", `/v1/conversations/${email.conversationId}/github-issue`, null, {
          title: "t",
          body: "b",
        })
      ).status,
    ).toBe(401);
    expect(
      (await call("POST", `/v1/conversations/${email.conversationId}/github-issue/draft`, null))
        .status,
    ).toBe(401);
  });

  it("is refused without github:write or conversations:read, in another workspace, or with nothing connected", async () => {
    const email = await receiveEmail();
    const path = `/v1/conversations/${email.conversationId}/github-issue`;
    expect((await call("POST", path, "readOnly", { title: "t", body: "b" })).status).toBe(403);
    // It would pick which customer is told "it's fixed" without being able to read the conversation.
    expect((await call("POST", path, "githubOnly", { title: "t", body: "b" })).status).toBe(403);
    expect((await call("POST", path, "otherOwner", { title: "t", body: "b" })).status).toBe(404);
    const otherEmail = await receiveEmail("help@other.test");
    const res = await call(
      "POST",
      `/v1/conversations/${otherEmail.conversationId}/github-issue`,
      "otherOwner",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
  });
});

describe("the webhook", () => {
  let secret: string;
  beforeAll(async () => {
    secret = await connect();
  });

  it("refuses a bad, missing or foreign signature, and an unknown workspace, all with 401", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const payload = closed(number);
    const refused = [
      await deliver("wrong secret", payload),
      await deliver(secret, payload, { signature: null }),
      await deliver(secret, payload, { signature: "sha256=00" }),
      await deliver(secret, payload, { workspace: other }),
      await deliver(secret, payload, { workspace: crypto.randomUUID() }),
      await deliver(secret, payload, { workspace: "not-a-uuid" }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    // A body changed after signing is refused too.
    const body = JSON.stringify(payload);
    const tampered = await app.request(`/v1/integrations/github/webhook?workspace=${acme}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signWebhook(secret, body),
      },
      body: body.replace(`"number":${number}`, `"number":${number + 1}`),
    });
    expect(tampered.status).toBe(401);
    // Nothing changed.
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toEqual([]);
  });

  it("answers GitHub's ping and ignores other events", async () => {
    const ping = await deliver(
      secret,
      { zen: "Keep it logically awesome.", hook_id: 1 },
      { event: "ping" },
    );
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ status: "ignored", conversations: 0 });
    const push = await deliver(secret, { ref: "refs/heads/main" }, { event: "push" });
    expect(await push.json()).toEqual({ status: "ignored", conversations: 0 });
  });

  it("treats the workspace ID in any letter case as the same workspace", async () => {
    const ping = { zen: "hi", hook_id: 1 };
    const res = await deliver(secret, ping, { event: "ping", workspace: acme.toUpperCase() });
    expect(res.status).toBe(200);
  });

  it("warns once about an unreadable secret, however many requests name the workspace", async () => {
    const oldKey = createSecretBox(randomBytes(32));
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.integrations)
        .set({
          webhookSecretCiphertext: oldKey.seal("lost", {
            tenantId: acme,
            purpose: "github-webhook-secret",
          }),
        })
        .where(eq(schema.integrations.provider, "github")),
    );
    const warnings = () =>
      logger.warn.mock.calls.filter((call) => JSON.stringify(call).includes("can't be read"))
        .length;
    const before = warnings();
    // The key is changed behind the app's back here, so nothing the app read before is kept.
    app = makeApp({ webhookSecretCacheMs: 0 });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await deliver(secret, { zen: "hi" }, { event: "ping" })).status).toBe(401);
      }
      expect(warnings() - before).toBe(1);
    } finally {
      app = makeApp();
    }
    // Mended by connecting again, as the warning says.
    secret = await connect();
    expect((await deliver(secret, { zen: "hi" }, { event: "ping" })).status).toBe(200);
  });

  it("asks GitHub when a close and a reopen share a second, instead of guessing", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    // GitHub's times are to the second.
    const second = new Date(Date.now() + 5_000).toISOString().replace(/\.\d+Z$/, "Z");
    const closing = closed(number, "completed", "acme/App", second);
    expect(await (await deliver(secret, closing)).json()).toMatchObject({ conversations: 1 });
    // Reopened in that same second: which came last can't be told from the times.
    const issue = openedIssues.find((i) => i.number === number);
    if (!issue) throw new Error("no issue");
    Object.assign(issue, { state: "open", state_reason: null });
    const reopened = { ...closed(number, null, "acme/App", second), action: "reopened" };
    expect(await (await deliver(secret, reopened)).json()).toEqual({
      status: "ignored",
      conversations: 0,
    });
    // The worker reads the state from GitHub, open, and applies that: no "it's fixed" waits.
    const stateOf = async () =>
      (
        (await (
          await call("GET", `/v1/conversations/${email.conversationId}`, "readOnly")
        ).json()) as {
          githubIssue: { state: string };
        }
      ).githubIssue.state;
    await waitFor("the reopen read from GitHub", async () =>
      (await stateOf()) === "open" ? true : undefined,
    );
    const live = (await draftsOf(email.conversationId)).filter(
      (d) => d.kind === "fixed" && d.status !== "discarded",
    );
    expect(live).toEqual([]);
    expect(await auditRows(email.conversationId)).toContainEqual({
      tenantId: acme,
      actorType: "system",
      actorId: "github-recheck",
      requestId: null,
      action: "github_issue.reopened",
      targetType: "conversation",
      targetId: email.conversationId,
    });
    const fixed = (await draftsOf(email.conversationId)).find((d) => d.kind === "fixed");
    expect(await auditRows(fixed?.id ?? "")).toContainEqual({
      tenantId: acme,
      actorType: "system",
      actorId: "github-recheck",
      requestId: null,
      action: "draft.discarded",
      targetType: "draft",
      targetId: fixed?.id,
    });
  });

  it("closed as completed → a pending 'fixed' draft; a replay changes nothing", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const res = await deliver(secret, closed(number));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "processed", conversations: 1 });

    const fixed = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ status: "pending", body: fixedNoticeBody });
    expect(fixed[0]?.messageId).toBe(email.messageId);
    expect(await auditActions(acme, email.conversationId)).toContain("github_issue.closed");
    const webhookContext = {
      tenantId: acme,
      actorType: "system",
      actorId: "github-webhook",
      requestId: res.headers.get("x-request-id"),
    };
    expect(webhookContext.requestId).toBeTruthy();
    expect(await auditRows(email.conversationId)).toContainEqual({
      ...webhookContext,
      action: "github_issue.closed",
      targetType: "conversation",
      targetId: email.conversationId,
    });
    expect(await auditRows(fixed[0]?.id ?? "")).toEqual([
      { ...webhookContext, action: "draft.created", targetType: "draft", targetId: fixed[0]?.id },
    ]);
    const conversation = await (
      await call("GET", `/v1/conversations/${email.conversationId}`, "readOnly")
    ).json();
    expect(conversation).toMatchObject({ githubIssue: { number, state: "closed" } });

    // GitHub retries, or someone replays the delivery: still one draft.
    const replay = await deliver(secret, closed(number));
    expect(await replay.json()).toEqual({ status: "ignored", conversations: 0 });
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toHaveLength(
      1,
    );

    // Reopened: the fix didn't hold, so the notice still waiting is withdrawn, never sent.
    await deliver(secret, { ...closed(number), action: "reopened" });
    const afterReopen = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
    expect(afterReopen.map((d) => d.status)).toEqual(["discarded"]);
    expect(await auditActions(acme, afterReopen[0]?.id ?? "")).toEqual([
      "draft.created",
      "draft.discarded",
    ]);
    // Closed again: one fresh notice, for the fix that holds this time.
    expect(await (await deliver(secret, closed(number))).json()).toEqual({
      status: "processed",
      conversations: 1,
    });
    const live = (await draftsOf(email.conversationId)).filter(
      (d) => d.kind === "fixed" && d.status !== "discarded",
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.status).toBe("pending");
  });

  it("reports the issue closed when its webhook closed the link before the state was read", async () => {
    const email = await receiveEmail();
    // The close's webhook lands between linking the issue and reading its state.
    duringStateCheck = async () => {
      duringStateCheck = undefined;
      const opened = openedIssues[0];
      if (!opened) throw new Error("no issue opened");
      Object.assign(opened, { state: "closed", state_reason: "completed" });
      expect(await (await deliver(secret, closed(opened.number))).json()).toEqual({
        status: "processed",
        conversations: 1,
      });
    };
    const res = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/github-issue`,
      "githubAgent",
      {
        title: "t",
        body: "b",
      },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ state: "closed" });
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toHaveLength(
      1,
    );
  });

  it("takes GitHub's form content type too, and refuses any other once signed", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const send = (type: string, body: string) =>
      app.request(`/v1/integrations/github/webhook?workspace=${acme}`, {
        method: "POST",
        headers: {
          "content-type": type,
          "x-github-event": "issues",
          "x-hub-signature-256": signWebhook(secret, body),
        },
        body,
      });
    const event = JSON.stringify(closed(number));
    expect((await send("text/plain", event)).status).toBe(415);
    const form = await send(
      "application/x-www-form-urlencoded",
      `payload=${encodeURIComponent(event)}`,
    );
    expect(await form.json()).toEqual({ status: "processed", conversations: 1 });
    expect((await send("application/x-www-form-urlencoded", "payload=not-json")).status).toBe(400);
  });

  it("ignores a late close, delivered again after the issue was reopened", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    const closedEarly = closed(number, "completed", "acme/App", at(1));
    expect(await (await deliver(secret, closedEarly)).json()).toMatchObject({ conversations: 1 });
    const reopened = { ...closed(number, null, "acme/App", at(2)), action: "reopened" };
    expect(await (await deliver(secret, reopened)).json()).toMatchObject({ conversations: 1 });
    // GitHub retries the first close: it is older than the reopen, so the issue stays open and
    // no customer is told it's fixed.
    expect(await (await deliver(secret, closedEarly)).json()).toEqual({
      status: "ignored",
      conversations: 0,
    });
    const live = (await draftsOf(email.conversationId)).filter(
      (d) => d.kind === "fixed" && d.status !== "discarded",
    );
    expect(live).toEqual([]);
    // A real, later close still counts.
    expect(
      await (await deliver(secret, closed(number, "completed", "acme/App", at(3)))).json(),
    ).toMatchObject({ conversations: 1 });
  });

  it("checks only a few deliveries at once, turning away what doesn't fit before the database", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lookups = 0;
    const slowDb: Pick<Database, "withTenant"> = {
      withTenant: async (tenantId, fn) => {
        lookups++;
        await held;
        return db.withTenant(tenantId, fn);
      },
    };
    const small = new OpenAPIHono();
    registerGithubWebhook(small, {
      db: slowDb,
      logger,
      secretBox: box,
      config: defaultConfig,
      verifyLimits: { concurrent: 1, waiting: 0, perWorkspace: 1, waitMs: 1_000 },
    });
    const first = forgedPing(small, acme);
    await waitFor("the first lookup", async () => (lookups > 0 ? true : undefined));
    // The same workspace again shares the lookup in progress: no second place in line.
    const again = forgedPing(small, acme);
    // Another workspace finds the line full.
    const second = await forgedPing(small, other);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ error: "busy" });
    expect(lookups).toBe(1);
    release();
    expect((await first).status).toBe(401);
    expect((await again).status).toBe(401);
    expect(lookups).toBe(1);
  });

  it("refuses forged requests for a workspace looked up moments ago with no database work", async () => {
    let lookups = 0;
    const countingDb: Pick<Database, "withTenant"> = {
      withTenant: (tenantId, fn) => {
        lookups++;
        return db.withTenant(tenantId, fn);
      },
    };
    const small = new OpenAPIHono();
    small.use(async (c, next) => {
      c.set("requestId", "test");
      await next();
    });
    registerGithubWebhook(small, { db: countingDb, logger, secretBox: box, config: defaultConfig });
    // Read once, for the first request.
    expect((await forgedPing(small, acme)).status).toBe(401);
    const once = lookups;
    expect(once).toBeGreaterThan(0);
    // A flood naming this workspace: each checked in memory, none reaching the database, so
    // none can hold up the workspace's real deliveries.
    for (let i = 0; i < 20; i++) expect((await forgedPing(small, acme)).status).toBe(401);
    expect(lookups).toBe(once);
    // The real secret still works, from memory too.
    const body = JSON.stringify({ zen: "hi" });
    const real = await small.request(`/v1/integrations/github/webhook?workspace=${acme}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signWebhook(secret, body),
      },
      body,
    });
    expect(real.status).toBe(200);
    expect(lookups).toBe(once);
  });

  it("ignores a late close even when its reopen was delivered first", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    // Closed at +1 and reopened at +2, but GitHub delivers the reopen first.
    const reopened = { ...closed(number, null, "acme/App", at(2)), action: "reopened" };
    await deliver(secret, reopened);
    expect(
      await (await deliver(secret, closed(number, "completed", "acme/App", at(1)))).json(),
    ).toEqual({ status: "ignored", conversations: 0 });
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toEqual([]);
  });

  it("acknowledges an event with no repository instead of refusing it", async () => {
    const res = await deliver(secret, { action: "created", repository: null }, { event: "issues" });
    expect(await res.json()).toEqual({ status: "ignored", conversations: 0 });
  });

  it("never leaves two 'fixed' drafts waiting on one conversation, even after the customer wrote again", async () => {
    const email = await receiveEmail();
    const add = () =>
      db.withTenant(acme, (tx) =>
        addFixedDraft(tx, {
          tenantId: acme,
          conversationId: email.conversationId,
          actor: githubWebhookActor,
          requestId: null,
          noticeDelaySeconds: 3600,
        }),
      );
    expect(await add()).not.toBeNull();
    // The customer writes again: a newer message the next notice would answer.
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.messages).values({
        tenantId: acme,
        conversationId: email.conversationId,
        direction: "inbound",
        fromAddress: "jane@customer.test",
        toAddresses: ["support@acme.test"],
        subject: "Still there?",
        textBody: "Any news?",
        references: [],
        rawFileKey: `${acme}/still-there`,
      }),
    );
    expect(await add()).toBeNull();
    const waiting = (await draftsOf(email.conversationId)).filter(
      (d) => d.kind === "fixed" && d.status === "pending",
    );
    expect(waiting).toHaveLength(1);
  });

  it("drafts a fresh fix notice when an issue whose notice was sent is reopened and closed again", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    await deliver(secret, closed(number, "completed", "acme/App", at(1)));
    // The first notice went out.
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.drafts)
        .set({ status: "sent" })
        .where(
          and(
            eq(schema.drafts.conversationId, email.conversationId),
            eq(schema.drafts.kind, "fixed"),
          ),
        ),
    );
    // The fix didn't hold: reopened, then closed for good.
    await deliver(secret, { ...closed(number, null, "acme/App", at(2)), action: "reopened" });
    await deliver(secret, closed(number, "completed", "acme/App", at(3)));
    const fixed = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
    expect(fixed.map((d) => d.status)).toEqual(["sent", "pending"]);
  });

  it("closed as not planned or duplicate → no 'fixed' draft", async () => {
    for (const reason of ["not_planned", "duplicate"]) {
      const email = await receiveEmail();
      const { number } = await createIssue(email.conversationId);
      expect(await (await deliver(secret, closed(number, reason))).json()).toEqual({
        status: "processed",
        conversations: 1,
      });
      expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toEqual([]);
    }
  });

  it("still closes a conversation linked while another repo was connected", async () => {
    const email = await receiveEmail();
    // A link from before the workspace switched repos.
    await db.withTenant(acme, (tx) =>
      tx.insert(schema.conversationGithubIssues).values({
        tenantId: acme,
        conversationId: email.conversationId,
        repo: "acme/old",
        issueNumber: 9,
        issueUrl: "https://github.com/acme/old/issues/9",
        state: "open",
      }),
    );
    const res = await deliver(secret, closed(9, "completed", "Acme/Old"));
    expect(await res.json()).toEqual({ status: "processed", conversations: 1 });
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toHaveLength(
      1,
    );
  });

  it("ignores an issue in a repo no conversation is linked to, even with this workspace's secret", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    const res = await deliver(secret, closed(number, "completed", "someone/else"));
    expect(await res.json()).toEqual({ status: "ignored", conversations: 0 });
    expect((await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed")).toEqual([]);
  });

  it("keeps a pending 'fixed' draft when the customer writes again or a reply is written", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    await deliver(secret, closed(number));
    // A new reply draft for the same message replaces pending replies, not the fixed notice.
    const reply = await call(
      "POST",
      `/v1/conversations/${email.conversationId}/drafts`,
      "readOnly",
      {
        body: "A reply written by hand.",
      },
    );
    expect(reply.status).toBe(201);
    const live = (await draftsOf(email.conversationId)).filter((d) => d.status === "pending");
    expect(live.map((d) => d.kind).sort()).toEqual(["fixed", "reply"]);
    const list = await (
      await call("GET", `/v1/conversations/${email.conversationId}/drafts`, "readOnly")
    ).json();
    expect((list as { drafts: { kind: string }[] }).drafts.map((d) => d.kind)).toContain("fixed");
  });

  it("the approved 'fixed' email goes to the shadow recipient, never the customer", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    await deliver(secret, closed(number));
    const [fixed] = (await draftsOf(email.conversationId)).filter((d) => d.kind === "fixed");
    if (!fixed) throw new Error("no fixed draft");

    const approve = await call("POST", `/v1/drafts/${fixed.id}/approve`, "approver", {
      body: fixed.body,
    });
    expect(approve.status).toBe(200);
    const mail = await waitFor("the fixed email", async () =>
      sent.find((m) => m.raw.includes(`Re: ${email.subject}`) && m.raw.includes("has been fixed")),
    );
    // Shadow mode is on for every new workspace: the owner gets it, the customer doesn't.
    expect(mail.to).toEqual(["owner@acme.test"]);
    // Header names are case-insensitive, and nodemailer normalises their case.
    expect(mail.raw.toLowerCase()).toContain(
      `${intendedToHeader.toLowerCase()}: jane@customer.test`,
    );
    expect(mail.raw).toContain("This reply was NOT sent to the customer");
    expect(sent.some((m) => m.to.includes("jane@customer.test"))).toBe(false);
    await waitFor("the draft marked sent", async () =>
      (await draftsOf(email.conversationId)).find((d) => d.id === fixed.id && d.status === "sent"),
    );
  });

  it("is refused once the repo is disconnected, and the stored token is gone", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.conversationId);
    expect((await call("DELETE", "/v1/integrations/github", "owner")).status).toBe(204);
    expect(await db.withTenant(acme, (tx) => tx.select().from(schema.integrations))).toEqual([]);
    expect((await deliver(secret, closed(number))).status).toBe(401);
    // The conversation keeps its link.
    const [link] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.conversationGithubIssues)
        .where(and(eq(schema.conversationGithubIssues.conversationId, email.conversationId))),
    );
    expect(link?.state).toBe("open");
    secret = await connect();
  });

  it("never wrote the token to a log", () => {
    expect(everythingLogged()).not.toContain(pat);
  });
});
