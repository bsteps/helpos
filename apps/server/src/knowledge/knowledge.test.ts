import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { embeddingDimensions } from "@helpos/ai";
import { mockEmbeddingModel, mockModel } from "@helpos/ai/testing";
import {
  type AuthStore,
  and,
  asc,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  enqueue,
  eq,
  type JobRunner,
  schema,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { createSafeFetch, isBlockedAddress, safeFetch } from "@helpos/safe-fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { utcDay } from "../ai-budget/budget.ts";
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { startWorker } from "../worker.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { type Fetcher, handleIngestSource } from "./ingest-worker.ts";
import { ingestSourceJob } from "./jobs.ts";
import { slugify } from "./routes.ts";
import { createVectorSearch } from "./search.ts";

/** Sends the API's reingest request. */
const reingest = (id: string, as = "editor") =>
  call("POST", `/v1/knowledge/sources/${id}/reingest`, as);

// The knowledge base end to end against real Postgres + pgvector and real pg-boss: add a
// source → the ingest job fetches (SSRF-safe), chunks and embeds it → a draft retrieves it,
// quotes it as data and records what it cited. Models are mocks; pages come from a local server.

const { auditEvents, aiUsage, draftCitations, drafts, knowledgeChunks, knowledgeSources } = schema;

const draftText =
  "Hi Jane, once we receive your return, the refund reaches your card within 5 business days.";
const model = mockModel({ text: `${draftText}\n[sources: K1]` });
const embeddingModel = mockEmbeddingModel();
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let server: Server;
let port: number;
let acme: string;
let other: string;
const requests: string[] = [];

const pages: Record<string, { type: string; body: string; status?: number; location?: string }> = {
  "/refunds": {
    type: "text/html; charset=utf-8",
    body: `<html><head><title>Refunds</title><script>track()</script></head><body>
        <nav>Home | Pricing | Login</nav>
        <main><h1>Refund policy</h1><p>Refunds reach your card within 5 business days of the
        return arriving.</p></main><footer>© Acme</footer></body></html>`,
  },
  "/shipping.md": {
    type: "text/markdown",
    body: "# Shipping\n\nStandard shipping takes 3 to 7 days.",
  },
  "/logo.png": { type: "image/png", body: "\x89PNG" },
  "/missing": { type: "text/html", body: "<p>Not found</p>", status: 404 },
  "/to-metadata": {
    type: "text/html",
    body: "",
    status: 302,
    location: "http://169.254.169.254/latest/meta-data/",
  },
};

/** Pages whose answer changes per request: the nth request gets the nth status (last repeats). */
const sequences: Record<string, { statuses: number[]; body: string }> = {
  "/flaky": { statuses: [503, 200], body: "<p>The flaky page says hello.</p>" },
  "/removed-later": { statuses: [200, 404], body: "<p>This page is removed later.</p>" },
};
const served: Record<string, number> = {};

const handler: RequestListener = (req, res) => {
  requests.push(req.url ?? "");
  const sequence = sequences[req.url ?? ""];
  if (sequence) {
    const n = served[req.url ?? ""] ?? 0;
    served[req.url ?? ""] = n + 1;
    const status = sequence.statuses[Math.min(n, sequence.statuses.length - 1)] ?? 500;
    res.writeHead(status, { "content-type": "text/html" });
    // A fixed body, never the request URL: echoing input into HTML is a pattern to avoid.
    res.end(status === 200 ? sequence.body : "");
    return;
  }
  const page = pages[req.url ?? ""];
  if (!page) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(page.status ?? 200, {
    "content-type": page.type,
    ...(page.location ? { location: page.location } : {}),
  });
  res.end(page.body);
};

/**
 * The real SSRF-safe fetch, except that `help.acme.test` resolves to the local test server and
 * exactly 127.0.0.1 is let through. Every other address, on every redirect, gets the real policy.
 */
const testFetch: Fetcher = (url, options = {}) =>
  createSafeFetch({
    isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
    resolve: async (hostname) => {
      if (hostname !== "help.acme.test") throw new Error(`ENOTFOUND ${hostname}`);
      return [{ address: "127.0.0.1", family: 4 }];
    },
  })(url, { ...options, allowedPorts: [port, 80, 443] });
const pageUrl = (path: string) => `http://help.acme.test:${port}${path}`;

const principals: Record<string, () => Principal> = {
  editor: () =>
    principal(acme, ["knowledge:read", "knowledge:write", "tickets:read", "drafts:write"]),
  reader: () => principal(acme, ["knowledge:read", "tickets:read"]),
  outsider: () => principal(other, ["knowledge:read", "knowledge:write", "tickets:read"]),
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

type SourceJson = {
  id: string;
  slug: string;
  status: string;
  error: string | null;
  visibility: string;
};

async function addSource(as: string, body: object): Promise<SourceJson> {
  const res = await call("POST", "/v1/knowledge/sources", as, body);
  if (res.status !== 201) throw new Error(`add source: ${res.status} ${await res.text()}`);
  return (await res.json()) as SourceJson;
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

/** Waits until the ingest job has finished with the source, either way. */
const ingested = (tenantId: string, id: string) =>
  waitFor(`source ${id} ingested`, async () => {
    const [row] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)),
    );
    return row && row.status !== "pending" ? row : undefined;
  });

const chunksOf = (tenantId: string, sourceId: string) =>
  db.withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.sourceId, sourceId))
      .orderBy(asc(knowledgeChunks.position)),
  );

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;

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
    model,
    embeddingModel,
    fetch: testFetch,
    transport: undefined,
    auth: undefined,
    publicUrl: "http://helpdesk.test",
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
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  server?.closeAllConnections();
  server?.close();
  await testDb?.container.stop();
});

describe("adding and ingesting sources", () => {
  it("ingests a markdown doc: chunks, embeddings, usage and audit events", async () => {
    const added = await addSource("editor", {
      kind: "markdown",
      title: "Password reset",
      content: "# Resetting your password\n\nUse the Forgot password link. It is valid for 1 hour.",
    });
    expect(added).toMatchObject({ slug: "password-reset", status: "pending", error: null });

    const row = await ingested(acme, added.id);
    expect(row).toMatchObject({ status: "ready", chunkCount: 1, error: null });
    const chunks = await chunksOf(acme, added.id);
    expect(chunks.map((c) => c.content)).toEqual([
      "# Resetting your password\n\nUse the Forgot password link. It is valid for 1 hour.",
    ]);
    expect(chunks[0]?.embedding).toHaveLength(embeddingDimensions);

    const [usage] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.day, utcDay(new Date()))),
    );
    expect(usage?.inputTokens).toBeGreaterThan(0);

    const events = await db.withTenant(acme, (tx) =>
      tx
        .select({ action: auditEvents.action, actorType: auditEvents.actorType })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, added.id))
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id)),
    );
    expect(events).toEqual([
      { action: "knowledge_source.created", actorType: "agent" },
      { action: "knowledge_source.ingested", actorType: "system" },
    ]);
  });

  it("fetches a web page and keeps its article text, not the navigation", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Refund policy",
      url: pageUrl("/refunds"),
      visibility: "public",
    });
    expect(added.visibility).toBe("public");
    expect((await ingested(acme, added.id)).status).toBe("ready");
    const [chunk] = await chunksOf(acme, added.id);
    expect(chunk?.content).toBe(
      "# Refund policy\n\nRefunds reach your card within 5 business days of the return arriving.",
    );
  });

  it("fetches a markdown page as text", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Shipping",
      url: pageUrl("/shipping.md"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    expect((await chunksOf(acme, added.id))[0]?.content).toContain("3 to 7 days");
  });

  it.each([
    ["/logo.png", "unsupported_content_type"],
    ["/missing", "http_404"],
  ])("marks %s failed with %s, without retrying", async (path, error) => {
    const added = await addSource("editor", { kind: "url", title: path, url: pageUrl(path) });
    expect(await ingested(acme, added.id)).toMatchObject({ status: "failed", error });
    expect(await chunksOf(acme, added.id)).toEqual([]);
  });

  it("lists the workspace's sources with their status", async () => {
    const res = await call("GET", "/v1/knowledge/sources", "reader");
    expect(res.status).toBe(200);
    const { sources } = (await res.json()) as { sources: SourceJson[] };
    expect(sources.map((s) => s.slug)).toEqual(
      expect.arrayContaining(["password-reset", "refund-policy", "shipping"]),
    );
    expect(sources[0]).toMatchObject({
      kind: "markdown",
      managedBy: "app",
      sourcePath: null,
      // Nothing is customer-facing unless someone chose it.
      visibility: "internal",
    });
  });
});

describe("re-ingesting", () => {
  it("recovers a source that failed on a temporary error", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Flaky",
      url: pageUrl("/flaky"),
    });
    expect(await ingested(acme, added.id)).toMatchObject({ status: "failed", error: "http_503" });

    const res = await reingest(added.id);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending", error: null });
    expect(await ingested(acme, added.id)).toMatchObject({ status: "ready", chunkCount: 1 });
    expect((await chunksOf(acme, added.id))[0]?.content).toBe("The flaky page says hello.");

    const events = await db.withTenant(acme, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.targetId, added.id))
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id)),
    );
    expect(events.map((e) => e.action)).toEqual([
      "knowledge_source.created",
      "knowledge_source.failed",
      "knowledge_source.reingest_requested",
      "knowledge_source.ingested",
    ]);
  });

  it("keeps the last good passages when a re-ingest fails", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Removed later",
      url: pageUrl("/removed-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    const before = await chunksOf(acme, added.id);

    expect((await reingest(added.id)).status).toBe(202);
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "http_404",
      chunkCount: 1,
    });
    expect((await chunksOf(acme, added.id)).map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  it("queues a new job even while the last one for the source still looks unfinished", async () => {
    // The race: an ingest job commits, and pg-boss hasn't marked it completed yet. A job with
    // the same dedupe key that won't start for a day stands in for that unfinished job.
    const added = await addSource("editor", { kind: "markdown", title: "Race", content: "Hi" });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    await db.withTenant(acme, (tx) =>
      enqueue(
        tx,
        ingestSourceJob,
        { tenantId: acme, sourceId: added.id },
        { singletonKey: added.id, startAfter: new Date(Date.now() + 86_400_000) },
      ),
    );
    expect((await reingest(added.id)).status).toBe(202);
    expect((await ingested(acme, added.id)).status).toBe("ready");
  });

  it("checks scope, workspace and git ownership", async () => {
    const added = await addSource("editor", { kind: "markdown", title: "Mine", content: "x" });
    expect((await reingest(added.id, "reader")).status).toBe(403);
    expect((await reingest(added.id, "outsider")).status).toBe(404);
    expect((await reingest("00000000-0000-7000-8000-000000000000")).status).toBe(404);
    expect((await call("POST", `/v1/knowledge/sources/${added.id}/reingest`, null)).status).toBe(
      401,
    );

    const [git] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({
          tenantId: acme,
          slug: "git-reingest",
          kind: "markdown",
          title: "x",
          content: "x",
          managedBy: "git",
          sourcePath: "knowledge/git-reingest.md",
        })
        .returning({ id: knowledgeSources.id }),
    );
    const res = await reingest(git?.id ?? "");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "managed_in_git" });
  });
});

describe("embedding model changes", () => {
  it("records which model made each source's passages", async () => {
    const added = await addSource("editor", { kind: "markdown", title: "Model", content: "Hi" });
    expect(await ingested(acme, added.id)).toMatchObject({
      embeddingModel: "mock/mock-embedding",
    });
    expect((await chunksOf(acme, added.id))[0]?.embeddingModel).toBe("mock/mock-embedding");
    const list = (await (await call("GET", "/v1/knowledge/sources", "reader")).json()) as {
      sources: { id: string; embeddingModel: string | null }[];
    };
    expect(list.sources.find((s) => s.id === added.id)?.embeddingModel).toBe("mock/mock-embedding");
  });

  it("a new model never compares against old vectors, and skips the embedding call", async () => {
    const newModel = mockEmbeddingModel("new-model");
    const result = await db.withTenant(acme, (tx) =>
      createVectorSearch(newModel).search(tx, { tenantId: acme, text: "refunds", limit: 5 }),
    );
    expect(result).toEqual({ hits: [], tokens: 0 });
    expect(newModel.doEmbedCalls).toEqual([]);
  });
});

describe("SSRF: every fetch goes through the safe fetch", () => {
  const ingestWith = (fetch: Fetcher, tenantId: string, sourceId: string) =>
    db.withTenant(tenantId, (tx) =>
      handleIngestSource({ embeddingModel, fetch, logger, dailyTokenBudget: 1_000_000 })(
        { tenantId, sourceId },
        tx,
      ),
    );

  /** A pending source the worker won't race us for: inserted directly, with no job. */
  async function pendingSource(url: string): Promise<string> {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId: acme, slug: `ssrf-${slugify(url)}`, kind: "url", title: "x", url })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    return row.id;
  }

  it.each([
    ["loopback", () => "http://127.0.0.1/refunds"],
    ["localhost", () => "http://localhost/refunds"],
    ["IPv6 loopback", () => "http://[::1]/refunds"],
    ["cloud metadata", () => "http://169.254.169.254/latest/meta-data/"],
    ["private network", () => "http://10.0.0.5/admin"],
  ])("refuses a %s address before connecting", async (_, url) => {
    const before = requests.length;
    const id = await pendingSource(url());
    await ingestWith(safeFetch, acme, id);
    const [row] = await db.withTenant(acme, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)),
    );
    expect(row).toMatchObject({ status: "failed", error: "blocked_address" });
    expect(requests.length).toBe(before);
  });

  it("refuses the test server itself without the test-only allowance", async () => {
    const before = requests.length;
    const id = await pendingSource(`http://127.0.0.1:${port}/refunds`);
    await ingestWith(safeFetch, acme, id);
    const [row] = await db.withTenant(acme, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)),
    );
    expect(row?.error).toMatch(/^blocked_/);
    expect(requests.length).toBe(before);
  });

  it("refuses a public page that redirects to the metadata address", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Redirect",
      url: pageUrl("/to-metadata"),
    });
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "blocked_address",
    });
  });

  it("rejects non-http URLs at the API", async () => {
    for (const url of ["file:///etc/passwd", "ftp://help.acme.test/x", "gopher://x.test/"]) {
      const res = await call("POST", "/v1/knowledge/sources", "editor", {
        kind: "url",
        title: "x",
        url,
      });
      expect(res.status, url).toBe(400);
    }
  });
});

describe("limits", () => {
  it("doesn't embed once today's AI budget is spent", async () => {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId: acme, slug: "budget", kind: "markdown", title: "x", content: "Hello" })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    const calls = embeddingModel.doEmbedCalls.length;
    await db.withTenant(acme, (tx) =>
      handleIngestSource({ embeddingModel, fetch: testFetch, logger, dailyTokenBudget: 0 })(
        { tenantId: acme, sourceId: row.id },
        tx,
      ),
    );
    expect(embeddingModel.doEmbedCalls.length).toBe(calls);
    expect(await ingested(acme, row.id)).toMatchObject({
      status: "failed",
      error: "daily_budget_reached",
    });
  });

  it("marks a source failed, not stuck pending, when the embedding call fails", async () => {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId: acme, slug: "embed-down", kind: "markdown", title: "x", content: "Hi" })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    const broken = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "broken",
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      doEmbed: async () => {
        throw new Error("401 invalid api key");
      },
    } as const;
    await db.withTenant(acme, (tx) =>
      handleIngestSource({
        embeddingModel: broken,
        fetch: testFetch,
        logger,
        dailyTokenBudget: 1_000_000,
      })({ tenantId: acme, sourceId: row.id }, tx),
    );
    expect(await ingested(acme, row.id)).toMatchObject({
      status: "failed",
      error: "embedding_failed",
    });
    expect(await chunksOf(acme, row.id)).toEqual([]);
  });

  it("the stored vector size matches the embedding model's", () => {
    expect(embeddingDimensions).toBe(schema.knowledgeEmbeddingDimensions);
  });
});

describe("knowledge API", () => {
  it("validates input", async () => {
    const post = (body: object) => call("POST", "/v1/knowledge/sources", "editor", body);
    expect((await post({ kind: "markdown", title: "x" })).status).toBe(400);
    expect((await post({ kind: "markdown", title: " ", content: "x" })).status).toBe(400);
    expect(
      (await post({ kind: "markdown", title: "x", content: "x", slug: "Bad Slug" })).status,
    ).toBe(400);
    expect((await post({ kind: "notion", title: "x", content: "x" })).status).toBe(400);
    expect(
      (await post({ kind: "url", title: "x", url: "https://x.test", content: "x" })).status,
    ).toBe(400);
    expect(
      (await post({ kind: "markdown", title: "x", content: "x", visibility: "secret" })).status,
    ).toBe(400);
  });

  it("a slug is unique per workspace only", async () => {
    const body = { kind: "markdown", title: "Billing FAQ", content: "Invoices are monthly." };
    await addSource("editor", { ...body, slug: "billing/faq" });
    const again = await call("POST", "/v1/knowledge/sources", "editor", {
      ...body,
      slug: "billing/faq",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "slug_taken" });
    // Another workspace can use it: the conflict says nothing about other workspaces.
    expect((await addSource("outsider", { ...body, slug: "billing/faq" })).slug).toBe(
      "billing/faq",
    );
  });

  it("makes a slug for titles without Latin letters", async () => {
    const added = await addSource("editor", { kind: "markdown", title: "返金", content: "x" });
    expect(added.slug).toMatch(/^source-[0-9a-f]{12}$/);
  });

  it("checks scopes", async () => {
    const body = { kind: "markdown", title: "x", content: "x" };
    expect((await call("POST", "/v1/knowledge/sources", "reader", body)).status).toBe(403);
    expect(
      (await call("DELETE", "/v1/knowledge/sources/00000000-0000-7000-8000-000000000000", "reader"))
        .status,
    ).toBe(403);
  });

  it.each([
    ["GET", "/v1/knowledge/sources"],
    ["POST", "/v1/knowledge/sources"],
    ["DELETE", "/v1/knowledge/sources/00000000-0000-7000-8000-000000000000"],
  ])("%s %s is 401 without credentials, and by default for everyone", async (method, path) => {
    const body = method === "POST" ? { kind: "markdown", title: "x", content: "x" } : undefined;
    expect((await call(method, path, null, body)).status).toBe(401);
    const res = await createApp({ db, files, logger, inboundSecret: undefined }).request(path, {
      method,
      headers: { authorization: "Bearer editor", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status).toBe(401);
  });

  it("deletes a source with its chunks, audit-logged", async () => {
    const added = await addSource("editor", { kind: "markdown", title: "Temp", content: "Gone." });
    await ingested(acme, added.id);
    const res = await call("DELETE", `/v1/knowledge/sources/${added.id}`, "editor");
    expect(res.status).toBe(204);
    expect(await chunksOf(acme, added.id)).toEqual([]);
    const events = await db.withTenant(acme, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, added.id),
            eq(auditEvents.action, "knowledge_source.deleted"),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect((await call("DELETE", `/v1/knowledge/sources/${added.id}`, "editor")).status).toBe(404);
  });

  it("refuses to delete a git-managed source", async () => {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({
          tenantId: acme,
          slug: "from-git",
          kind: "markdown",
          title: "From git",
          content: "x",
          managedBy: "git",
          sourcePath: "knowledge/from-git.md",
          sourceCommit: "abc123",
        })
        .returning({ id: knowledgeSources.id }),
    );
    const res = await call("DELETE", `/v1/knowledge/sources/${row?.id}`, "editor");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "managed_in_git" });
  });

  it("another workspace can't see or delete Acme's sources", async () => {
    const added = await addSource("editor", { kind: "markdown", title: "Private", content: "x" });
    const list = (await (await call("GET", "/v1/knowledge/sources", "outsider")).json()) as {
      sources: SourceJson[];
    };
    expect(list.sources.map((s) => s.id)).not.toContain(added.id);
    expect((await call("DELETE", `/v1/knowledge/sources/${added.id}`, "outsider")).status).toBe(
      404,
    );
    expect((await ingested(acme, added.id)).id).toBe(added.id);
  });

  it("the routes are in the OpenAPI spec", async () => {
    const spec = (await (await app().request("/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(Object.keys(spec.paths["/v1/knowledge/sources"] ?? {})).toEqual(["get", "post"]);
    expect(Object.keys(spec.paths["/v1/knowledge/sources/{id}"] ?? {})).toEqual(["delete"]);
    expect(Object.keys(spec.paths["/v1/knowledge/sources/{id}/reingest"] ?? {})).toEqual(["post"]);
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(["KnowledgeSource", "DraftSource"]),
    );
  });
});

describe("drafting with knowledge", () => {
  let otherRefund: string;

  beforeAll(async () => {
    // Other's article matches a refund question even better than Acme's. It must never be used.
    otherRefund = (
      await addSource("outsider", {
        kind: "markdown",
        title: "Other refund policy",
        content: "Refunds refunds refunds: OTHER-SECRET refunds take 90 days for your order.",
      })
    ).id;
    await ingested(other, otherRefund);
  });

  it("leak: vector search as Acme never returns Other's chunks", async () => {
    const search = createVectorSearch(embeddingModel);
    const result = await db.withTenant(acme, (tx) =>
      search.search(tx, { tenantId: acme, text: "refunds refunds OTHER-SECRET", limit: 20 }),
    );
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.map((h) => h.sourceId)).not.toContain(otherRefund);
    expect(result.hits.map((h) => h.content).join(" ")).not.toContain("OTHER-SECRET");
  });

  it("a public-only search never returns internal notes", async () => {
    const search = createVectorSearch(embeddingModel);
    const result = await db.withTenant(acme, (tx) =>
      search.search(tx, {
        tenantId: acme,
        text: "refunds password shipping",
        limit: 20,
        visibility: ["public"],
      }),
    );
    expect(result.hits.map((h) => [h.title, h.visibility])).toEqual([["Refund policy", "public"]]);
  });

  it("retrieves the matching article, quotes it as data, and the draft shows its sources", async () => {
    const raw = [
      "From: Jane Customer <jane@customer.test>",
      "To: support@acme.test",
      "Subject: Refund for my return",
      "Message-ID: <refund-1@customer.test>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hi, I sent my order back. How long do refunds take to reach my card?",
    ].join("\r\n");
    const email = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
    if (email.kind !== "created") throw new Error(`ingest: ${email.kind}`);

    const draft = await waitFor("draft", async () => {
      const [row] = await db.withTenant(acme, (tx) =>
        tx.select().from(drafts).where(eq(drafts.ticketId, email.ticketId)),
      );
      return row;
    });
    // The sources line is for us, not the customer: it is never in the draft body.
    expect(draft.body).toBe(draftText);

    const prompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
    expect(prompt).toMatch(
      /<untrusted_knowledge>.*K1.*Refund policy.*5 business days.*<\/untrusted_knowledge>.*<untrusted_email>/,
    );
    expect(prompt).not.toContain("OTHER-SECRET");
    // The public page is offered with its address; the internal notes are marked, without one.
    expect(prompt).toContain(pageUrl("/refunds"));
    expect(prompt).toMatch(/\\"internal\\": true/);
    const system = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt[0]);
    expect(system).not.toContain("5 business days");

    const res = await call("GET", `/v1/tickets/${email.ticketId}/drafts`, "editor");
    expect(res.status).toBe(200);
    const { drafts: list } = (await res.json()) as {
      drafts: {
        sources: {
          title: string;
          cited: boolean;
          url: string | null;
          visibility: string;
          excerpt: string;
        }[];
      }[];
    };
    const sources = list[0]?.sources ?? [];
    expect(sources[0]).toEqual({
      sourceId: expect.any(String),
      title: "Refund policy",
      url: pageUrl("/refunds"),
      visibility: "public",
      excerpt: expect.stringContaining("5 business days"),
      cited: true,
    });
    // The rest were offered but not cited, and none come from another workspace.
    expect(sources.slice(1).every((s) => !s.cited)).toBe(true);
    expect(sources.slice(1).length).toBeGreaterThan(0);
    expect(sources.slice(1).every((s) => s.visibility === "internal")).toBe(true);
    expect(sources.map((s) => s.title)).not.toContain("Other refund policy");

    const citations = await db.withTenant(acme, (tx) =>
      tx.select().from(draftCitations).where(eq(draftCitations.draftId, draft.id)),
    );
    expect(citations.length).toBe(sources.length);
  });
});
