import { randomBytes } from "node:crypto";
import { mockModel } from "@helpos/ai/testing";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { intendedToHeader } from "../outbound-email/shadow.ts";
import type { EmailTransport } from "../outbound-email/transport.ts";
import { createSecretBox } from "../secrets/secret-box.ts";
import { startWorker } from "../worker.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { fixedNoticeBody } from "./fixed-notice.ts";
import { octokitGithub } from "./github-api.ts";
import { signWebhook } from "./webhook-signature.ts";

// Ticket → GitHub issue → customer told when it's fixed, against real Postgres, RLS, pg-boss and
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
let acme: string;
let other: string;

// --- Fake GitHub: what Octokit sent, and what GitHub answers -----------------------------------

type GithubCall = { method: string; path: string; authorization: string | null; body: unknown };
const githubCalls: GithubCall[] = [];
let githubDown = false;
let nextIssue = 100;

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
  if (request.method === "POST" && path === "/repos/acme/app/issues") {
    const number = nextIssue++;
    return reply(201, { number, html_url: `https://github.com/acme/app/issues/${number}` });
  }
  return reply(404, { message: "Not Found" });
};

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
  "tickets:read",
  "tickets:write",
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
  githubAgent: () => agent(acme, ["tickets:read", "github:write"]),
  // An agent can't hold workspace:admin, but even a caller claiming it as an agent is refused.
  adminAgent: () => agent(acme, [...allScopes, "workspace:admin"]),
  readOnly: () => agent(acme, ["tickets:read", "drafts:write", "drafts:approve"]),
  approver: () => agent(acme, ["tickets:read", "drafts:approve"]),
  otherOwner: () => ({
    tenantId: other,
    actor: { type: "user", id: "other-owner" },
    scopes: new Set([...allScopes, "workspace:admin"]),
  }),
};
function agent(tenantId: string, scopes: Scope[]): Principal {
  return { tenantId, actor: { type: "agent", id: "test-agent" }, scopes: new Set(scopes) };
}

function makeApp(overrides: { secretBox?: undefined; model?: undefined; budget?: number } = {}) {
  return createApp({
    db,
    files,
    logger,
    inboundSecret: undefined,
    noticeDelaySeconds: 3600,
    publicUrl: "https://help.acme.test/desk",
    dailyTokenBudget: overrides.budget ?? 1_000_000,
    model: "model" in overrides ? undefined : issueModel,
    secretBox: "secretBox" in overrides ? undefined : box,
    github: octokitGithub({ baseUrl: "https://api.github.test", fetch: fakeGithubFetch }),
    authenticate: async (req) => {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      return principals[token]?.() ?? null;
    },
  });
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

const draftsOf = (ticketId: string) =>
  db.withTenant(acme, (tx) =>
    tx
      .select()
      .from(schema.drafts)
      .where(eq(schema.drafts.ticketId, ticketId))
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

/** Everything the server wrote to its logs and answered, as one string to search for secrets. */
const everythingLogged = () =>
  JSON.stringify([logger.error.mock.calls, logger.warn.mock.calls, logger.info.mock.calls]);

/** Connects acme/app as the owner and returns the webhook secret. */
async function connect(): Promise<string> {
  const res = await call("PUT", "/v1/integrations/github", "owner", {
    repo: "Acme/App",
    token: pat,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { webhookSecret: string };
  return body.webhookSecret;
}

async function createIssue(ticketId: string) {
  const res = await call("POST", `/v1/tickets/${ticketId}/github-issue`, "githubAgent", {
    title: "Export fails",
    body: "Steps: open Reports.",
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { number: number; url: string };
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

const closed = (number: number, stateReason: string | null = "completed", repo = "acme/App") => ({
  action: "closed",
  issue: { number, state: "closed", state_reason: stateReason, title: "ignored" },
  repository: { full_name: repo },
  sender: { login: "octocat" },
});

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: (error) => {
      throw error;
    },
    pollingIntervalSeconds: 0.5,
  });
  await runner.start();
  await startWorker({
    runner,
    files,
    logger,
    model: mockModel({ text: replyText }),
    embeddingModel: undefined,
    transport,
    auth: undefined,
    publicUrl: "https://help.acme.test",
    noticeDelaySeconds: 3600,
    dailyTokenBudget: 1_000_000,
  });
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
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.container.stop();
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
    expect(githubCalls.at(-1)).toMatchObject({
      method: "GET",
      path: "/repos/acme/app",
      authorization: `token ${pat}`,
    });

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
});

describe("drafting an issue with the AI", () => {
  it("suggests a cleaned-up issue from the ticket, counted against the budget", async () => {
    const email = await receiveEmail("support@acme.test", "Export fails. Assign @ceo, label P0!");
    const res = await call(
      "POST",
      `/v1/tickets/${email.ticketId}/github-issue/draft`,
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
    expect(await auditActions(acme, email.ticketId)).toContain("github_issue.drafted");
  });

  it("needs github:write, a model, budget left, and a ticket in this workspace", async () => {
    const email = await receiveEmail();
    const path = `/v1/tickets/${email.ticketId}/github-issue/draft`;
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
  it("sends only the title and body, and links the issue to the ticket", async () => {
    const email = await receiveEmail();
    const before = githubCalls.length;
    const issue = await createIssue(email.ticketId);
    expect(issue.url).toBe(`https://github.com/acme/app/issues/${issue.number}`);

    const posted = githubCalls.slice(before);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      method: "POST",
      path: "/repos/acme/app/issues",
      authorization: `token ${pat}`,
    });
    // Exactly these two fields: no labels, assignees or milestone can ride along.
    expect(posted[0]?.body).toEqual({ title: "Export fails", body: "Steps: open Reports." });

    const ticket = await call("GET", `/v1/tickets/${email.ticketId}`, "readOnly");
    expect(await ticket.json()).toMatchObject({
      githubIssue: { repo: "acme/app", number: issue.number, url: issue.url, state: "open" },
    });
    expect(await auditActions(acme, email.ticketId)).toContain("github_issue.created");

    // One issue per ticket.
    const again = await call("POST", `/v1/tickets/${email.ticketId}/github-issue`, "githubAgent", {
      title: "Again",
      body: "",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_linked" });
  });

  it("refuses extra fields such as labels or assignees", async () => {
    const email = await receiveEmail();
    const res = await call("POST", `/v1/tickets/${email.ticketId}/github-issue`, "githubAgent", {
      title: "t",
      body: "b",
      labels: ["P0"],
      assignees: ["ceo"],
    });
    expect(res.status).toBe(400);
  });

  it("links nothing when GitHub fails, so it can be tried again", async () => {
    const email = await receiveEmail();
    githubDown = true;
    const res = await call("POST", `/v1/tickets/${email.ticketId}/github-issue`, "githubAgent", {
      title: "t",
      body: "b",
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "github_unavailable" });
    expect(text).not.toContain(pat);
    githubDown = false;
    await createIssue(email.ticketId);
    expect(everythingLogged()).not.toContain(pat);
  });

  it("is refused without github:write, in another workspace, or with nothing connected", async () => {
    const email = await receiveEmail();
    const path = `/v1/tickets/${email.ticketId}/github-issue`;
    expect((await call("POST", path, "readOnly", { title: "t", body: "b" })).status).toBe(403);
    expect((await call("POST", path, "otherOwner", { title: "t", body: "b" })).status).toBe(404);
    const otherEmail = await receiveEmail("help@other.test");
    const res = await call(
      "POST",
      `/v1/tickets/${otherEmail.ticketId}/github-issue`,
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
    const { number } = await createIssue(email.ticketId);
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
    expect((await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed")).toEqual([]);
  });

  it("answers GitHub's ping and ignores other events", async () => {
    const ping = await deliver(
      secret,
      { zen: "Keep it logically awesome.", hook_id: 1 },
      { event: "ping" },
    );
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ status: "ignored", tickets: 0 });
    const push = await deliver(secret, { ref: "refs/heads/main" }, { event: "push" });
    expect(await push.json()).toEqual({ status: "ignored", tickets: 0 });
  });

  it("closed as completed → a pending 'fixed' draft; a replay changes nothing", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.ticketId);
    const res = await deliver(secret, closed(number));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "processed", tickets: 1 });

    const fixed = (await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ status: "pending", body: fixedNoticeBody });
    expect(fixed[0]?.messageId).toBe(email.messageId);
    expect(await auditActions(acme, email.ticketId)).toContain("github_issue.closed");
    const ticket = await (await call("GET", `/v1/tickets/${email.ticketId}`, "readOnly")).json();
    expect(ticket).toMatchObject({ githubIssue: { number, state: "closed" } });

    // GitHub retries, or someone replays the delivery: still one draft.
    const replay = await deliver(secret, closed(number));
    expect(await replay.json()).toEqual({ status: "ignored", tickets: 0 });
    expect((await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed")).toHaveLength(1);

    // Reopened and closed again: the customer isn't told twice while the first notice is live.
    await deliver(secret, { ...closed(number), action: "reopened" });
    expect(await (await deliver(secret, closed(number))).json()).toEqual({
      status: "processed",
      tickets: 1,
    });
    expect((await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed")).toHaveLength(1);
  });

  it("closed as not planned or duplicate → no 'fixed' draft", async () => {
    for (const reason of ["not_planned", "duplicate"]) {
      const email = await receiveEmail();
      const { number } = await createIssue(email.ticketId);
      expect(await (await deliver(secret, closed(number, reason))).json()).toEqual({
        status: "processed",
        tickets: 1,
      });
      expect((await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed")).toEqual([]);
    }
  });

  it("ignores an issue in another repo, even with this workspace's secret", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.ticketId);
    const res = await deliver(secret, closed(number, "completed", "someone/else"));
    expect(await res.json()).toEqual({ status: "ignored", tickets: 0 });
    expect((await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed")).toEqual([]);
  });

  it("keeps a pending 'fixed' draft when the customer writes again or a reply is written", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.ticketId);
    await deliver(secret, closed(number));
    // A new reply draft for the same message replaces pending replies, not the fixed notice.
    const reply = await call("POST", `/v1/tickets/${email.ticketId}/drafts`, "readOnly", {
      body: "A reply written by hand.",
    });
    expect(reply.status).toBe(201);
    const live = (await draftsOf(email.ticketId)).filter((d) => d.status === "pending");
    expect(live.map((d) => d.kind).sort()).toEqual(["fixed", "reply"]);
    const list = await (
      await call("GET", `/v1/tickets/${email.ticketId}/drafts`, "readOnly")
    ).json();
    expect((list as { drafts: { kind: string }[] }).drafts.map((d) => d.kind)).toContain("fixed");
  });

  it("the approved 'fixed' email goes to the shadow recipient, never the customer", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.ticketId);
    await deliver(secret, closed(number));
    const [fixed] = (await draftsOf(email.ticketId)).filter((d) => d.kind === "fixed");
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
      (await draftsOf(email.ticketId)).find((d) => d.id === fixed.id && d.status === "sent"),
    );
  });

  it("is refused once the repo is disconnected, and the stored token is gone", async () => {
    const email = await receiveEmail();
    const { number } = await createIssue(email.ticketId);
    expect((await call("DELETE", "/v1/integrations/github", "owner")).status).toBe(204);
    expect(await db.withTenant(acme, (tx) => tx.select().from(schema.integrations))).toEqual([]);
    expect((await deliver(secret, closed(number))).status).toBe(401);
    // The ticket keeps its link.
    const [link] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.ticketGithubIssues)
        .where(and(eq(schema.ticketGithubIssues.ticketId, email.ticketId))),
    );
    expect(link?.state).toBe("open");
    secret = await connect();
  });

  it("never wrote the token to a log", () => {
    expect(everythingLogged()).not.toContain(pat);
  });
});
