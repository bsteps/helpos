import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { embedBatchSize, embeddingDimensions } from "@helpos/ai";
import { mockEmbeddingModel, mockModel, providerDownError } from "@helpos/ai/testing";
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
  sql,
  tenantTransactions,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { createSafeFetch, isBlockedAddress, safeFetch } from "@helpos/safe-fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { totalTokens, usageOn, utcDay } from "../ai-budget/budget.ts";
import { createApp } from "../app.ts";
import type { Principal, Scope } from "../auth/principal.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { startWorker } from "../worker.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { maxChunks } from "./chunk.ts";
import {
  type Fetcher,
  handleIngestSource,
  maxPageBytes,
  nextUtcDay,
  retryDelayMs,
} from "./ingest-worker.ts";
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
/** Valid text, but Postgres can't store it. */
const nul = String.fromCharCode(0);

const pages: Record<
  string,
  { type: string; body: string | Buffer; status?: number; location?: string }
> = {
  // A quoted charset label is valid HTTP; the bytes are Latin-1, not UTF-8.
  "/latin1": {
    type: 'text/html; charset="iso-8859-1"',
    body: Buffer.from("<p>Café crème: refunds in 5 days.</p>", "latin1"),
  },
  // No charset in the header: the page declares it itself.
  "/latin1-meta": {
    type: "text/html",
    body: Buffer.from('<meta charset="windows-1252"><p>Crème brûlée is free.</p>', "latin1"),
  },
  // No charset anywhere, and the bytes aren't valid UTF-8: an old Latin-1 page.
  "/undeclared-latin1": {
    type: "text/html",
    body: Buffer.from("<p>Remboursé sous 5 jours.</p>", "latin1"),
  },
  "/indented.md": {
    type: "text/markdown",
    body: "# Config\n\nSet this:\n\n```yaml\nrefunds:\n  window_days: 30\n```",
  },
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
  "/nul.txt": { type: "text/plain", body: `Refunds${nul} take 5 days.` },
  // A server that labels plain ASCII as UTF-16: read literally, it would be nonsense.
  "/utf16-label": { type: "text/html; charset=utf-16", body: "<p>Refunds in 5 days.</p>" },
  // Real UTF-16, with its byte order mark.
  "/utf16-real": {
    type: "text/html; charset=utf-16",
    body: Buffer.from(`${String.fromCharCode(0xfeff)}<p>Real UTF-16 page.</p>`, "utf16le"),
  },
  // A description that mentions a charset declares none: the UTF-8 bytes stay UTF-8.
  "/meta-description": {
    type: "text/html",
    body: Buffer.from(
      '<meta name="description" content="Set charset=iso-8859-1 here"><p>Crème brûlée.</p>',
      "utf8",
    ),
  },
  // The server can never answer this, so it isn't tried again.
  "/not-implemented": { type: "text/html", body: "", status: 501 },
  "/slow": { type: "text/html", body: "<p>A page that takes a while to fetch.</p>" },
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
const sequences: Record<string, { statuses: number[]; body: string; bodies?: string[] }> = {
  "/flaky": { statuses: [503, 200], body: "<p>The flaky page says hello.</p>" },
  // Down for longer than one ingest's tries (the first and two more).
  "/down-a-while": { statuses: [503, 503, 503, 200], body: "<p>Back up now.</p>" },
  "/grown-later": {
    statuses: [200],
    body: "",
    bodies: ["<p>Small at first.</p>", `<p>${"x".repeat(maxPageBytes)}</p>`],
  },
  "/emptied-later": {
    statuses: [200],
    body: "",
    bodies: ["<p>This page has text at first.</p>", "<p></p>"],
  },
  "/removed-later": { statuses: [200, 404], body: "<p>This page is removed later.</p>" },
  "/login-later": { statuses: [200, 403], body: "<p>Public at first, then blocked.</p>" },
  "/withheld-later": { statuses: [200, 451], body: "<p>Withheld later.</p>" },
  "/down-for-good": { statuses: [503], body: "" },
  "/down-later": { statuses: [200, 503], body: "<p>This page goes down later.</p>" },
};
const served: Record<string, number> = {};

const handler: RequestListener = (req, res) => {
  // By path: tests tell sources of one page apart by their query (one source per URL).
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  requests.push(path);
  const sequence = sequences[path];
  if (sequence) {
    const n = served[path] ?? 0;
    served[path] = n + 1;
    const status = sequence.statuses[Math.min(n, sequence.statuses.length - 1)] ?? 500;
    res.writeHead(status, { "content-type": "text/html" });
    // A fixed body, never the request URL: echoing input into HTML is a pattern to avoid.
    const body = sequence.bodies?.[Math.min(n, sequence.bodies.length - 1)] ?? sequence.body;
    res.end(status === 200 ? body : "");
    return;
  }
  const page = pages[path];
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
  /** Can read tickets and their drafts, but not the knowledge base. */
  ticketsOnly: () => principal(acme, ["tickets:read"]),
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

const sourceOf = async (tenantId: string, id: string) => {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)),
  );
  return row;
};

/**
 * A URL source added straight to the table, so no job is queued for it. The slug goes in the
 * query: a workspace has one source per URL, and several tests use the same page.
 */
async function insertUrlSource(slug: string, path: string): Promise<string> {
  const [row] = await db.withTenant(acme, (tx) =>
    tx
      .insert(knowledgeSources)
      .values({
        tenantId: acme,
        slug,
        kind: "url",
        title: slug,
        url: pageUrl(`${path}?source=${slug}`),
      })
      .returning({ id: knowledgeSources.id }),
  );
  if (!row) throw new Error("no row");
  return row.id;
}

/** A fetch that waits for release(), so a test can act while a page is being fetched. */
function gatedFetch() {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let markStarted = () => {};
  const started = new Promise<void>((done) => {
    markStarted = done;
  });
  const fetch: Fetcher = async (url, options) => {
    markStarted();
    await gate;
    return testFetch(url, options);
  };
  return { fetch, started, release: () => release() };
}

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
    fetchRetryDelaysMs: [20, 20],
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

  it("decodes a page in the charset it declares, quoted or not", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Latin-1 page",
      url: pageUrl("/latin1"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    expect((await chunksOf(acme, added.id))[0]?.content).toBe("Café crème: refunds in 5 days.");

    const meta = await addSource("editor", {
      kind: "url",
      title: "Meta charset page",
      url: pageUrl("/latin1-meta"),
    });
    expect((await ingested(acme, meta.id)).status).toBe("ready");
    expect((await chunksOf(acme, meta.id))[0]?.content).toBe("Crème brûlée is free.");

    const undeclared = await addSource("editor", {
      kind: "url",
      title: "Old page",
      url: pageUrl("/undeclared-latin1"),
    });
    expect((await ingested(acme, undeclared.id)).status).toBe("ready");
    expect((await chunksOf(acme, undeclared.id))[0]?.content).toBe("Remboursé sous 5 jours.");
  });

  it("keeps the indentation of code in a markdown page", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Config",
      url: pageUrl("/indented.md"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    expect((await chunksOf(acme, added.id))[0]?.content).toContain("refunds:\n  window_days: 30");
  });

  it("refuses a document with more passages than a source may have, instead of cutting it", async () => {
    const sections = Array.from({ length: maxChunks + 1 }, (_, i) => `# Part ${i}\n\nText ${i}.`);
    const added = await addSource("editor", {
      kind: "markdown",
      title: "Huge manual",
      content: sections.join("\n\n"),
    });
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "too_long",
      chunkCount: 0,
    });
    expect(await chunksOf(acme, added.id)).toEqual([]);
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

  it("drops NUL characters from a page instead of failing the source", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "NUL",
      url: pageUrl("/nul.txt"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    expect((await chunksOf(acme, added.id)).map((c) => c.content)).toEqual([
      "Refunds take 5 days.",
    ]);
  });

  it("isn't fooled by a charset mentioned in another meta tag's text", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Meta description",
      url: pageUrl("/meta-description"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    expect((await chunksOf(acme, added.id)).map((c) => c.content)).toEqual(["Crème brûlée."]);
  });

  it("reads a page labelled UTF-16 that isn't, and a real UTF-16 page", async () => {
    for (const [path, text] of [
      ["/utf16-label", "Refunds in 5 days."],
      ["/utf16-real", "Real UTF-16 page."],
    ] as const) {
      const added = await addSource("editor", { kind: "url", title: path, url: pageUrl(path) });
      expect((await ingested(acme, added.id)).status).toBe("ready");
      expect((await chunksOf(acme, added.id)).map((c) => c.content)).toEqual([text]);
    }
  });

  it("doesn't try again on an error that can't pass, such as 501", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Not implemented",
      url: pageUrl("/not-implemented"),
    });
    expect(await ingested(acme, added.id)).toMatchObject({ status: "failed", error: "http_501" });
    expect(requests.filter((path) => path === "/not-implemented")).toHaveLength(1);
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
  it("tries a page again by itself after a temporary error", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Flaky",
      url: pageUrl("/flaky"),
    });
    expect(await ingested(acme, added.id)).toMatchObject({ status: "ready", chunkCount: 1 });
    expect((await chunksOf(acme, added.id))[0]?.content).toBe("The flaky page says hello.");
    expect(served["/flaky"]).toBe(2);
  });

  it("gives a site still down after the quick tries one more try later, and recovers", async () => {
    const id = await insertUrlSource("down-a-while", "/down-a-while");
    // Started long enough ago that its one more try is due now: the worker runs it.
    await handleIngestSource({
      embeddingModel,
      fetch: testFetch,
      logger,
      dailyTokenBudget: 1_000_000,
      fetchRetryDelaysMs: [20, 20],
      now: () => new Date(Date.now() - retryDelayMs - 60_000),
    })({ tenantId: acme, sourceId: id }, tenantTransactions(db, acme));
    expect(served["/down-a-while"]).toBe(3);
    expect(await ingested(acme, id)).toMatchObject({ status: "ready", error: null });
    expect((await chunksOf(acme, id))[0]?.content).toBe("Back up now.");
    expect(served["/down-a-while"]).toBe(4);
  });

  it("fails a site that is still down after its one more try, so it never retries forever", async () => {
    const id = await insertUrlSource("down-for-good", "/down-for-good");
    const ingest = () =>
      handleIngestSource({
        embeddingModel,
        fetch: testFetch,
        logger,
        dailyTokenBudget: 1_000_000,
        fetchRetryDelaysMs: [20, 20],
      })({ tenantId: acme, sourceId: id }, tenantTransactions(db, acme));
    await ingest();
    expect(await sourceOf(acme, id)).toMatchObject({ status: "pending", error: "http_503" });
    // The one more try (run here instead of in 15 minutes).
    await ingest();
    expect(await sourceOf(acme, id)).toMatchObject({ status: "failed", error: "http_503" });

    // Asked again by hand, it gets a fresh try and a fresh wait.
    expect(await (await reingest(id)).json()).toMatchObject({ status: "pending", error: null });
  });

  it("keeps the last good passages when a re-ingest hits a temporary error", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Down later",
      url: pageUrl("/down-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");
    const before = await chunksOf(acme, added.id);

    expect((await reingest(added.id)).status).toBe(202);
    // It waits for its one more try; drafts keep using what they had.
    expect(
      await waitFor("the re-ingest to wait", async () => {
        const row = await sourceOf(acme, added.id);
        return row?.error === "http_503" ? row : undefined;
      }),
    ).toMatchObject({ status: "pending", chunkCount: 1 });
    expect((await chunksOf(acme, added.id)).map((c) => c.id)).toEqual(before.map((c) => c.id));
  });

  it("drops the passages of a page that now has no text: they describe a page that's gone", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Emptied later",
      url: pageUrl("/emptied-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");

    expect((await reingest(added.id)).status).toBe(202);
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "no_text",
      chunkCount: 0,
    });
    expect(await chunksOf(acme, added.id)).toEqual([]);
  });

  it("drops the passages of a page that has grown past the size limit", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Grown later",
      url: pageUrl("/grown-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");

    expect((await reingest(added.id)).status).toBe(202);
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "too_large",
      chunkCount: 0,
    });
    expect(await chunksOf(acme, added.id)).toEqual([]);
  });

  it("keeps the passages of a page that now answers 403: often a bot block, not a removal", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Login later",
      url: pageUrl("/login-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");

    expect((await reingest(added.id)).status).toBe(202);
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "http_403",
      chunkCount: 1,
    });
  });

  it("drops the passages of a page that is now withheld for legal reasons", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Withheld later",
      url: pageUrl("/withheld-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");

    expect((await reingest(added.id)).status).toBe(202);
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "http_451",
      chunkCount: 0,
    });
    expect(await chunksOf(acme, added.id)).toEqual([]);
  });

  it("drops the passages of a page that is now gone, so drafts stop citing it", async () => {
    const added = await addSource("editor", {
      kind: "url",
      title: "Removed later",
      url: pageUrl("/removed-later"),
    });
    expect((await ingested(acme, added.id)).status).toBe("ready");

    expect((await reingest(added.id)).status).toBe(202);
    expect(await ingested(acme, added.id)).toMatchObject({
      status: "failed",
      error: "http_404",
      chunkCount: 0,
      embeddingModel: null,
    });
    expect(await chunksOf(acme, added.id)).toEqual([]);
  });

  it("holds no lock while it fetches: a delete goes through at once", async () => {
    const { fetch, started, release } = gatedFetch();
    const id = await insertUrlSource("held-fetch", "/refunds");
    const run = handleIngestSource({ embeddingModel, fetch, logger, dailyTokenBudget: 1_000_000 })(
      { tenantId: acme, sourceId: id },
      tenantTransactions(db, acme),
    );
    await started;
    // With the row locked for the whole fetch, this would wait for release() and never return.
    expect((await call("DELETE", `/v1/knowledge/sources/${id}`, "editor")).status).toBe(204);
    release();
    await run;
    expect(await sourceOf(acme, id)).toBeUndefined();
    expect(await chunksOf(acme, id)).toEqual([]);
  });

  it("a re-ingest asked for during a fetch gets a run of its own", async () => {
    const { fetch, started, release } = gatedFetch();
    const id = await insertUrlSource("asked-again", "/slow");
    const run = handleIngestSource({ embeddingModel, fetch, logger, dailyTokenBudget: 1_000_000 })(
      { tenantId: acme, sourceId: id },
      tenantTransactions(db, acme),
    );
    await started;
    // Stands in for a re-ingest request that reused this very job: it only counts up.
    await db.withTenant(acme, (tx) =>
      tx
        .update(knowledgeSources)
        .set({ ingestRequests: sql`${knowledgeSources.ingestRequests} + 1` })
        .where(eq(knowledgeSources.id, id)),
    );
    release();
    await run;
    // This run's page was fetched before the request, so it wasn't written. It queued another
    // run instead, which the worker picked up and which fetched the page again.
    expect((await ingested(acme, id)).status).toBe("ready");
    expect(requests.filter((path) => path === "/slow")).toHaveLength(2);
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
    handleIngestSource({ embeddingModel, fetch, logger, dailyTokenBudget: 1_000_000 })(
      { tenantId, sourceId },
      tenantTransactions(db, tenantId),
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
  it("waits for the daily budget to reset instead of failing, then runs by itself", async () => {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId: acme, slug: "budget", kind: "markdown", title: "x", content: "Hello" })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    const calls = embeddingModel.doEmbedCalls.length;
    const ingestAt = (now: Date) =>
      handleIngestSource({
        embeddingModel,
        fetch: testFetch,
        logger,
        dailyTokenBudget: 0,
        now: () => now,
      })({ tenantId: acme, sourceId: row.id }, tenantTransactions(db, acme));

    // Its retry is queued for midnight UTC, so it waits, pending, with the reason.
    await ingestAt(new Date());
    expect(embeddingModel.doEmbedCalls.length).toBe(calls);
    expect(await sourceOf(acme, row.id)).toMatchObject({
      status: "pending",
      error: "daily_budget_reached",
    });

    // A wait that began yesterday is due now, and the worker (with budget left) runs it.
    await ingestAt(new Date(Date.now() - 86_400_000));
    expect(await ingested(acme, row.id)).toMatchObject({ status: "ready", error: null });
  });

  it("doesn't fetch a page while its source waits for the budget", async () => {
    const id = await insertUrlSource("budget-url", "/budget-page");
    await handleIngestSource({ embeddingModel, fetch: testFetch, logger, dailyTokenBudget: 0 })(
      { tenantId: acme, sourceId: id },
      tenantTransactions(db, acme),
    );
    expect(await sourceOf(acme, id)).toMatchObject({
      status: "pending",
      error: "daily_budget_reached",
    });
    expect(requests).not.toContain("/budget-page");
  });

  it("asking again while it waits for the budget keeps the reason it waits", async () => {
    const id = await insertUrlSource("budget-reason", "/refunds");
    await handleIngestSource({ embeddingModel, fetch: testFetch, logger, dailyTokenBudget: 0 })(
      { tenantId: acme, sourceId: id },
      tenantTransactions(db, acme),
    );
    const res = await reingest(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: "pending", error: "daily_budget_reached" });
  });

  it("waits once when the embedding provider is down, then fails if it still is", async () => {
    const busy = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "busy",
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      doEmbed: async () => {
        throw providerDownError();
      },
    } as const;
    const markdownSource = async (slug: string) => {
      const [row] = await db.withTenant(acme, (tx) =>
        tx
          .insert(knowledgeSources)
          .values({ tenantId: acme, slug, kind: "markdown", title: "x", content: "Hi" })
          .returning({ id: knowledgeSources.id }),
      );
      if (!row) throw new Error("no row");
      return row.id;
    };
    const ingestAt = (id: string, now: Date) =>
      handleIngestSource({
        embeddingModel: busy,
        fetch: testFetch,
        logger,
        dailyTokenBudget: 1_000_000,
        now: () => now,
      })({ tenantId: acme, sourceId: id }, tenantTransactions(db, acme));

    const stuck = await markdownSource("embed-busy");
    await ingestAt(stuck, new Date());
    expect(await sourceOf(acme, stuck)).toMatchObject({
      status: "pending",
      error: "embedding_unavailable",
    });
    // Its one more try (run here instead of in 15 minutes) meets the same outage.
    await ingestAt(stuck, new Date());
    expect(await sourceOf(acme, stuck)).toMatchObject({
      status: "failed",
      error: "embedding_unavailable",
    });

    // A wait that began long enough ago is due now, and the worker's working model runs it.
    const recovers = await markdownSource("embed-busy-then-up");
    await ingestAt(recovers, new Date(Date.now() - retryDelayMs - 60_000));
    expect(await ingested(acme, recovers)).toMatchObject({ status: "ready", error: null });
  });

  it("a budget wait keeps a temporary reason, so it doesn't earn another try", async () => {
    const id = await insertUrlSource("budget-after-503", "/refunds");
    // As left by a first try that met a 503.
    await db.withTenant(acme, (tx) =>
      tx.update(knowledgeSources).set({ error: "http_503" }).where(eq(knowledgeSources.id, id)),
    );
    await handleIngestSource({ embeddingModel, fetch: testFetch, logger, dailyTokenBudget: 0 })(
      { tenantId: acme, sourceId: id },
      tenantTransactions(db, acme),
    );
    expect(await sourceOf(acme, id)).toMatchObject({ status: "pending", error: "http_503" });
  });

  it("one more try is shared: after the site's, a provider outage fails the source", async () => {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        // As left by a first try that met a 503 from the site.
        .values({
          tenantId: acme,
          slug: "site-then-provider",
          kind: "markdown",
          title: "x",
          content: "Hi",
          error: "http_503",
        })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    const busy = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "busy",
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      doEmbed: async () => {
        throw providerDownError();
      },
    } as const;
    await handleIngestSource({
      embeddingModel: busy,
      fetch: testFetch,
      logger,
      dailyTokenBudget: 1e6,
    })({ tenantId: acme, sourceId: row.id }, tenantTransactions(db, acme));
    // Taking turns between a site and a provider that are down must not wait forever.
    expect(await sourceOf(acme, row.id)).toMatchObject({
      status: "failed",
      error: "embedding_unavailable",
    });
  });

  it("fails a source whose page can't be read, rather than leave it pending", async () => {
    const id = await insertUrlSource("reader-breaks", "/refunds");
    const broken: Fetcher = async () => {
      throw new TypeError("a bug, not a fetch error");
    };
    await handleIngestSource({ embeddingModel, fetch: broken, logger, dailyTokenBudget: 1e6 })(
      { tenantId: acme, sourceId: id },
      tenantTransactions(db, acme),
    );
    expect(await sourceOf(acme, id)).toMatchObject({ status: "failed", error: "ingest_error" });
  });

  it("the budget wait ends at the next midnight UTC", () => {
    expect(nextUtcDay(new Date("2026-03-31T23:59:59Z")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(nextUtcDay(new Date("2026-12-31T00:00:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
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
    await handleIngestSource({
      embeddingModel: broken,
      fetch: testFetch,
      logger,
      dailyTokenBudget: 1_000_000,
    })({ tenantId: acme, sourceId: row.id }, tenantTransactions(db, acme));
    expect(await ingested(acme, row.id)).toMatchObject({
      status: "failed",
      error: "embedding_failed",
    });
    expect(await chunksOf(acme, row.id)).toEqual([]);
  });

  it("counts the batches embedded before a failed one, since they were paid for", async () => {
    // Another workspace, so no other test's job adds to the usage measured here.
    const content = Array.from(
      { length: embedBatchSize + 6 },
      (_, i) => `# Part ${i}\n\nText ${i}.`,
    ).join("\n\n");
    const [row] = await db.withTenant(other, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({ tenantId: other, slug: "embed-partial", kind: "markdown", title: "x", content })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    let calls = 0;
    const partial = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "partial",
      maxEmbeddingsPerCall: 1_000,
      supportsParallelCalls: false,
      doEmbed: async ({ values }: { values: string[] }) => {
        if (++calls > 1) throw new Error("429 rate limited");
        return {
          embeddings: values.map(() => new Array<number>(embeddingDimensions).fill(0.1)),
          usage: { tokens: 30 },
          warnings: [],
        };
      },
    } as const;
    const usedToday = () =>
      db.withTenant(other, async (tx) => totalTokens(await usageOn(tx, utcDay(new Date()))));
    const before = await usedToday();
    await handleIngestSource({
      embeddingModel: partial,
      fetch: testFetch,
      logger,
      dailyTokenBudget: 1_000_000,
    })({ tenantId: other, sourceId: row.id }, tenantTransactions(db, other));
    expect(await ingested(other, row.id)).toMatchObject({
      status: "failed",
      error: "embedding_failed",
    });
    expect((await usedToday()) - before).toBe(30);
  });

  it("marks a source failed, not stuck pending, when the server returns too few vectors", async () => {
    const [row] = await db.withTenant(acme, (tx) =>
      tx
        .insert(knowledgeSources)
        .values({
          tenantId: acme,
          slug: "embed-short",
          kind: "markdown",
          title: "x",
          content: "Hi",
        })
        .returning({ id: knowledgeSources.id }),
    );
    if (!row) throw new Error("no row");
    const short = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "short",
      maxEmbeddingsPerCall: 100,
      supportsParallelCalls: true,
      doEmbed: async () => ({ embeddings: [], usage: { tokens: 3 }, warnings: [] }),
    } as const;
    await handleIngestSource({
      embeddingModel: short,
      fetch: testFetch,
      logger,
      dailyTokenBudget: 1_000_000,
    })({ tenantId: acme, sourceId: row.id }, tenantTransactions(db, acme));
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
    // Postgres can't store NUL: a 400, not a failed insert.
    expect((await post({ kind: "markdown", title: "x", content: `a${nul}b` })).status).toBe(400);
    expect((await post({ kind: "markdown", title: `a${nul}b`, content: "x" })).status).toBe(400);
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

  it("a URL is one source per workspace only", async () => {
    const post = (as: string, url: string, title = "Refund policy") =>
      call("POST", "/v1/knowledge/sources", as, { kind: "url", title, url });
    const first = await post("editor", "https://Docs.Example.test:443/refunds?lang=en");
    expect(first.status).toBe(201);
    const { id, slug } = (await first.json()) as SourceJson;
    // The same page: other fragment, host case, default port, or title (so another slug).
    for (const url of [
      "https://docs.example.test/refunds?lang=en",
      "https://DOCS.example.test/refunds?lang=en#step-2",
      "https://docs.example.test:443/refunds?lang=en#",
    ]) {
      const again = await post("editor", url, "Refunds again");
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "url_taken", sourceId: id });
    }
    // The same slug too: whichever constraint Postgres checks first, it's the URL that's taken.
    const sameSlug = await call("POST", "/v1/knowledge/sources", "editor", {
      kind: "url",
      title: "Refund policy",
      url: "https://docs.example.test/refunds?lang=en",
      slug,
    });
    expect(await sameSlug.json()).toEqual({ error: "url_taken", sourceId: id });
    // A different path or query is a different page.
    expect((await post("editor", "https://docs.example.test/Refunds?lang=en")).status).toBe(201);
    expect((await post("editor", "https://docs.example.test/refunds?lang=fr")).status).toBe(201);
    // Another workspace can add it, and its conflict names only its own source.
    const theirs = await post("outsider", "https://docs.example.test/refunds?lang=en");
    expect(theirs.status).toBe(201);
    const { id: theirId } = (await theirs.json()) as SourceJson;
    expect(theirId).not.toBe(id);
    const theirAgain = await post("outsider", "https://docs.example.test/refunds?lang=en#x");
    expect(await theirAgain.json()).toEqual({ error: "url_taken", sourceId: theirId });
  });

  it("makes a unique slug when another source has the same title", async () => {
    const body = { kind: "markdown", title: "Same title", content: "x" };
    const first = await addSource("editor", body);
    const second = await addSource("editor", body);
    const third = await addSource("editor", body);
    expect(first.slug).toBe("same-title");
    expect(second.slug).toMatch(/^same-title-[0-9a-f]{12}$/);
    expect(third.slug).toMatch(/^same-title-[0-9a-f]{12}$/);
    expect(third.slug).not.toBe(second.slug);
  });

  it("keeps accented words whole in slugs", () => {
    expect(slugify("Résumé naïve Café")).toBe("resume-naive-cafe");
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
  ])("%s %s is 401 without credentials, and by default for a fake token", async (method, path) => {
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

  it("a public-only search in a workspace with only internal notes makes no embedding call", async () => {
    const fresh = mockEmbeddingModel();
    const result = await db.withTenant(other, (tx) =>
      createVectorSearch(fresh).search(tx, {
        tenantId: other,
        text: "refunds",
        limit: 5,
        visibility: ["public"],
      }),
    );
    expect(result).toEqual({ hits: [], tokens: 0 });
    expect(fresh.doEmbedCalls).toEqual([]);
  });

  it("a search that allows no visibility finds nothing, and makes no call", async () => {
    const fresh = mockEmbeddingModel();
    const result = await db.withTenant(acme, (tx) =>
      createVectorSearch(fresh).search(tx, {
        tenantId: acme,
        text: "refunds",
        limit: 5,
        visibility: [],
      }),
    );
    expect(result).toEqual({ hits: [], tokens: 0 });
    expect(fresh.doEmbedCalls).toEqual([]);
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

    type Source = {
      sourceId: string | null;
      title: string;
      cited: boolean;
      url: string | null;
      visibility: string;
      excerpt: string;
    };
    const sourcesOfDraft = async (as = "editor"): Promise<Source[]> => {
      const res = await call("GET", `/v1/tickets/${email.ticketId}/drafts`, as);
      expect(res.status).toBe(200);
      const { drafts: list } = (await res.json()) as { drafts: { sources: Source[] }[] };
      return list[0]?.sources ?? [];
    };
    const sources = await sourcesOfDraft();
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
    // Reading drafts isn't a way around knowledge:read: no titles, links or passages.
    expect(sources.length).toBeGreaterThan(0);
    expect(await sourcesOfDraft("ticketsOnly")).toEqual([]);
    // But every reader learns an internal note was involved, so an approver knows to check.
    for (const as of ["editor", "ticketsOnly"]) {
      const res = await call("GET", `/v1/tickets/${email.ticketId}/drafts`, as);
      const { drafts: list } = (await res.json()) as { drafts: { internalKnowledge: boolean }[] };
      expect(list[0]?.internalKnowledge).toBe(true);
    }

    // The draft follows the notes without quoting them: not flagged. Pasting one in (as a model
    // steered by the email might) flags it for every reader; editing it out clears the flag.
    const quotes = async (as: string) => {
      const res = await call("GET", `/v1/tickets/${email.ticketId}/drafts`, as);
      const { drafts: list } = (await res.json()) as { drafts: { quotesInternalNote: boolean }[] };
      return list[0]?.quotesInternalNote;
    };
    expect(await quotes("editor")).toBe(false);
    // An internal note the model was shown but didn't cite: pasting it is caught all the same.
    const uncited = sources.find((s) => s.visibility === "internal" && !s.cited);
    const note = uncited?.excerpt;
    if (!note) throw new Error("no uncited internal source");
    const edit = (body: string) => call("PATCH", `/v1/drafts/${draft.id}`, "editor", { body });
    expect((await edit(`${draftText}\n\nStaff notes: ${note}`)).status).toBe(200);
    expect(await quotes("editor")).toBe(true);
    // Not to a caller without knowledge:read: edit after edit, the flag would let them guess the note.
    expect(await quotes("ticketsOnly")).toBe(false);
    expect((await edit(draftText)).status).toBe(200);
    expect(await quotes("editor")).toBe(false);

    const citations = await db.withTenant(acme, (tx) =>
      tx.select().from(draftCitations).where(eq(draftCitations.draftId, draft.id)),
    );
    expect(citations.length).toBe(sources.length);

    // The draft's record of what it was written from survives the source changing...
    const refundId = sources[0]?.sourceId;
    if (!refundId) throw new Error("no refund source");
    expect((await reingest(refundId)).status).toBe(202);
    expect((await ingested(acme, refundId)).status).toBe("ready");
    expect(await sourcesOfDraft()).toEqual(sources);
    // ...and being deleted: only the link to it goes.
    expect((await call("DELETE", `/v1/knowledge/sources/${refundId}`, "editor")).status).toBe(204);
    expect(await sourcesOfDraft()).toEqual([
      { ...sources[0], sourceId: null },
      ...sources.slice(1),
    ]);
  });
});
