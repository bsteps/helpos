import { randomBytes } from "node:crypto";
import { mockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  type JobRunner,
  uuidv7,
} from "@helpos/db";
import {
  type LeakTenant,
  leakFixtureDay,
  seedLeakTenant,
  startTestDatabase,
  type TestDatabase,
  tenantSnapshot,
  uncoveredTables,
} from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { type Principal, scopes } from "./auth/principal.ts";
import { octokitGithub } from "./github/github-api.ts";
import { ensureJobQueues } from "./jobs.ts";
import { openApiDocument } from "./openapi.ts";
import { createSecretBox } from "./secrets/secret-box.ts";
import { composeServices, defaultConfig } from "./services.ts";

const bTag = "leak-b";
const aInputTokens = 17;
const bInputTokens = 987654;

const sampleBodies: Record<string, unknown> = {
  "POST /v1/inbound/email": `From: x@elsewhere.test\r\nTo: support@${bTag}.test\r\nSubject: hi\r\nMessage-ID: <leak-probe@elsewhere.test>\r\n\r\nhello`,
  "POST /v1/auth/sign-in": { email: `owner@${bTag}.test`, password: "a wrong password" },
  "POST /v1/auth/password": { token: "not-a-real-token", password: "a long enough password" },
  "POST /v1/tokens": { name: "leak-probe", scopes: ["tickets:read"] },
  "POST /v1/tickets/{id}/drafts": { body: "A reply." },
  "PATCH /v1/drafts/{id}": { body: "An edited reply." },
  "POST /v1/drafts/{id}/approve": { body: "A reply." },
  "POST /v1/knowledge/sources": { kind: "markdown", title: "Probe", content: "A probe note." },
  "PATCH /v1/knowledge/sources/{id}": { title: "A new title" },
  "PATCH /v1/workspace/shadow-mode": { recipient: "probe@leak-a.test" },
  "PUT /v1/integrations/github": {
    repo: "leak-a-corp/app",
    token: `github_pat_${"A".repeat(30)}`,
  },
  "POST /v1/tickets/{id}/github-issue": { title: "A title", body: "A body." },
  "POST /v1/integrations/github/webhook": { action: "closed" },
};

interface Operation {
  method: string;
  path: string;
  pathParams: string[];
  uuidQuery: string[];
  bodyType: string | undefined;
}

type Doc = {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: { in: string; name: string; schema?: { format?: string } }[];
        requestBody?: { content: Record<string, unknown> };
      }
    >
  >;
};

async function operations(): Promise<Operation[]> {
  const doc = (await openApiDocument()) as Doc;
  return Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => {
      const params = op.parameters ?? [];
      const types = Object.keys(op.requestBody?.content ?? {});
      return {
        method: method.toUpperCase(),
        path,
        pathParams: params.filter((p) => p.in === "path").map((p) => p.name),
        uuidQuery: params
          .filter((p) => p.in === "query" && p.schema?.format === "uuid")
          .map((p) => p.name),
        bodyType: types.includes("application/json") ? "application/json" : types[0],
      };
    }),
  );
}

const ops = await operations();
const withIds = ops.filter((op) => op.pathParams.length > 0);
const readsWithIds = withIds.filter((op) => op.method === "GET");

const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const githubCalls: string[] = [];
const github = octokitGithub({
  baseUrl: "https://github.invalid",
  fetch: async (input, init) => {
    githubCalls.push(new Request(input, init).url);
    return new Response(JSON.stringify({ message: "Bad credentials" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  },
});

type Caller = "user" | "agent";
const callers: Caller[] = ["user", "agent"];

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let a: LeakTenant;
let b: LeakTenant;
let before: Record<string, unknown[]>;
let markers: string[];
let bIds: string[];
let aIds: string[];
let app: ReturnType<typeof createApp>;

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const uuidsIn = (value: unknown): string[] => [
  ...new Set(JSON.stringify(value).match(uuidPattern) ?? []),
];

function principal(caller: Caller): Principal {
  return {
    tenantId: a.tenantId,
    actor: { type: caller, id: caller === "agent" ? a.ids.token : uuidv7() },
    scopes: new Set(scopes),
  };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await ensureJobQueues(runner, defaultConfig);
  a = await seedLeakTenant(db, auth, {
    tenantId: uuidv7(),
    tag: "leak-a",
    inputTokens: aInputTokens,
  });
  b = await seedLeakTenant(db, auth, {
    tenantId: uuidv7(),
    tag: bTag,
    inputTokens: bInputTokens,
    draftStatus: "discarded",
  });
  before = await tenantSnapshot(testDb.ownerUrl, b.tenantId);
  bIds = uuidsIn(before);
  markers = [b.tag, ...bIds];
  aIds = uuidsIn(await tenantSnapshot(testDb.ownerUrl, a.tenantId));
  app = createApp(
    composeServices({
      db,
      files,
      logger,
      secretBox: createSecretBox(randomBytes(32)),
      model: mockModel({ text: "{}" }),
      github,
      clock: { now: () => new Date(`${leakFixtureDay}T12:00:00Z`) },
    }),
    {
      authenticate: async (request) => {
        const caller = request.headers.get("x-leak-caller");
        return caller === "user" || caller === "agent" ? principal(caller) : null;
      },
    },
  );
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

async function send(op: Operation, caller: Caller, id?: string) {
  const path = op.path.replaceAll(/\{[^}]+\}/g, id ?? "");
  const query = op.uuidQuery.map((name) => `${name}=${b.tenantId}`).join("&");
  const init: RequestInit = { method: op.method, headers: { "x-leak-caller": caller } };
  if (op.bodyType) {
    const sample = sampleBodies[`${op.method} ${op.path}`];
    if (sample === undefined) {
      throw new Error(
        `${op.method} ${op.path} takes a body: add a valid sample body to sampleBodies in apps/server/src/leak.int.test.ts`,
      );
    }
    init.headers = { ...init.headers, "content-type": op.bodyType };
    init.body = typeof sample === "string" ? sample : JSON.stringify(sample);
  }
  const res = await app.request(query ? `${path}?${query}` : path, init);
  return { status: res.status, text: await res.text() };
}

type Reply = { status: number; text: string };
type ExpectedReply = { status: number; body?: Record<string, unknown>; contains?: string };

function expectedReplies(caller: Caller): Record<string, ExpectedReply> {
  const sessionRequired = { status: 403, body: { error: "session_required" } };
  const human = (reply: ExpectedReply) => (caller === "user" ? reply : sessionRequired);
  return {
    "POST /v1/inbound/email": { status: 401, body: { error: "unauthorized" } },
    "POST /v1/auth/sign-in": { status: 503, body: { error: "sessions_disabled" } },
    "POST /v1/auth/sign-out": { status: 503, body: { error: "sessions_disabled" } },
    "POST /v1/auth/password": { status: 503, body: { error: "sessions_disabled" } },
    "GET /v1/me": { status: 200, body: { workspace: { id: a.tenantId } } },
    "POST /v1/tokens": human({
      status: 201,
      body: { name: "leak-probe", scopes: ["tickets:read"] },
    }),
    "GET /v1/tokens": human({ status: 200, contains: a.ids.token }),
    "GET /v1/tickets": { status: 200, contains: a.ids.ticket },
    "GET /v1/ai-usage": {
      status: 200,
      body: {
        day: leakFixtureDay,
        inputTokens: aInputTokens,
        outputTokens: 0,
        totalTokens: aInputTokens,
        calls: 0,
        dailyTokenBudget: defaultConfig.dailyTokenBudget,
        remainingTokens: defaultConfig.dailyTokenBudget - aInputTokens,
        paused: false,
      },
    },
    "GET /v1/knowledge/sources": { status: 200, contains: a.ids.source },
    "POST /v1/knowledge/sources": { status: 201, body: { title: "Probe" } },
    "GET /v1/stats/drafts": {
      status: 200,
      body: {
        approvedUnchanged: 0,
        approvedEdited: 0,
        discarded: 0,
        pending: 1,
        unchangedRate: null,
      },
    },
    "GET /v1/workspace/shadow-mode": {
      status: 200,
      body: { enabled: true, recipient: `owner@${a.tag}.test` },
    },
    "PATCH /v1/workspace/shadow-mode": {
      status: 200,
      body: { enabled: true, recipient: "probe@leak-a.test" },
    },
    "GET /v1/integrations/github": {
      status: 200,
      body: { connected: true, repo: `${a.tag}-corp/app` },
    },
    "PUT /v1/integrations/github": human({ status: 422, body: { error: "token_rejected" } }),
    "DELETE /v1/integrations/github": human({ status: 204 }),
    "POST /v1/integrations/github/webhook-secret": human({
      status: 404,
      body: { error: "not_connected" },
    }),
    "POST /v1/integrations/github/webhook": { status: 401, body: { error: "unauthorized" } },
  };
}

function expectNoLeak(reply: Reply, what: string): void {
  const found = markers.filter((m) => reply.text.includes(m));
  expect(found, `${what} answered ${reply.status} with B's data: ${reply.text}`).toEqual([]);
}

const withoutId = (reply: Reply, id: string) => ({
  status: reply.status,
  text: reply.text.replaceAll(id, "<id>"),
});

describe("the sweep has something to find", () => {
  it("found the operations", () => {
    expect(ops.length).toBeGreaterThan(25);
    expect(withIds.length).toBeGreaterThan(10);
  });

  it("has a complete workspace for A and for B", async () => {
    expect(
      uncoveredTables(before),
      "add a row for each of these tables in seedLeakTenant (packages/db/src/testing.ts)",
    ).toEqual([]);
    expect(uncoveredTables(await tenantSnapshot(testDb.ownerUrl, a.tenantId))).toEqual([]);
    expect(bIds.length).toBeGreaterThan(15);
  });

  it("has no sample body for an operation that doesn't exist", () => {
    const known = new Set(ops.map((op) => `${op.method} ${op.path}`));
    expect(Object.keys(sampleBodies).filter((key) => !known.has(key))).toEqual([]);
  });
});

describe("leak: every API operation, called as tenant A", () => {
  it.each(
    ops.map((op) => ({
      ...op,
      name:
        op.method === "GET" && op.path === "/v1/tickets/{id}"
          ? "leak: fetching B's ticket ID as A returns 404"
          : `${op.method} ${op.path} shows nothing of B and changes nothing of B`,
    })),
  )("$name", async (op) => {
    githubCalls.length = 0;
    for (const caller of callers) {
      const who = `${op.method} ${op.path} as ${caller}`;
      if (op.pathParams.length === 0) {
        const expected = expectedReplies(caller)[`${op.method} ${op.path}`];
        if (!expected) throw new Error(`${who}: add an expected response to expectedReplies`);
        const reply = await send(op, caller);
        expectNoLeak(reply, who);
        expect(reply.status, `${who}: ${reply.text}`).toBe(expected.status);
        if (expected.body !== undefined)
          expect(JSON.parse(reply.text), who).toMatchObject(expected.body);
        if (expected.contains !== undefined) expect(reply.text, who).toContain(expected.contains);
        continue;
      }
      const unknownId = uuidv7();
      const unknown = await send(op, caller, unknownId);
      expectNoLeak(unknown, `${who} with an unknown ID`);
      const agentRevokesOnlyItsOwnToken =
        caller === "agent" &&
        op.method === "DELETE" &&
        op.path === "/v1/tokens/{id}" &&
        unknown.status === 403;
      expect(
        agentRevokesOnlyItsOwnToken || unknown.status === 404,
        `${who} with an unknown ID gave ${unknown.status} ${unknown.text}: the request should reach its lookup and find nothing (is the sample body valid?)`,
      ).toBe(true);
      for (const id of bIds) {
        const reply = await send(op, caller, id);
        expectNoLeak(reply, `${who} with B's ID ${id}`);
        expect(withoutId(reply, id), `${who} with B's ID ${id} differs from an unknown ID`).toEqual(
          withoutId(unknown, unknownId),
        );
      }
    }
    expect(
      githubCalls.filter((url) => !url.startsWith("https://github.invalid/repos/leak-a-corp/")),
      `${op.method} ${op.path} asked GitHub about a repo that isn't A's`,
    ).toEqual([]);
    expect(
      await tenantSnapshot(testDb.ownerUrl, b.tenantId),
      `${op.method} ${op.path} changed B's data`,
    ).toEqual(before);
  });
});

describe("a passing sweep means something", () => {
  it.each(readsWithIds)("$method $path shows A's own data for an ID of A", async (op) => {
    for (const caller of callers) {
      let found = false;
      for (const id of aIds) {
        const reply = await send(op, caller, id);
        if (reply.status === 200 && reply.text.includes(a.tag)) {
          found = true;
          break;
        }
      }
      expect(
        found,
        `${op.method} ${op.path} as ${caller} never returned A's data for any of A's IDs, so a 404 for B's IDs proves nothing`,
      ).toBe(true);
    }
  });
});
