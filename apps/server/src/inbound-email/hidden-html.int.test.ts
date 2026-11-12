import { readFileSync } from "node:fs";
import { mockEmbeddingModel, mockModel } from "@helpos/ai/testing";
import { type AuthStore, createAuthStore, createDatabase, type Database } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { composeServer, type Server } from "../server.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";

const model = mockModel({ text: "Please reset your password." });
const embeddingModel = mockEmbeddingModel();
const secret = "hidden-html-fixture";
let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let server: Server;
let tenantId: string;
beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  const workspace = await initWorkspace(
    { db, auth },
    {
      workspace: "Hidden HTML",
      mailbox: "support@acme.test",
      owner: "owner@acme.test",
    },
  );
  if (!workspace.ok) throw new Error("Workspace setup failed");
  tenantId = workspace.tenantId;
  server = composeServer({
    db,
    auth,
    jobsUrl: testDb.jobsUrl,
    pollingIntervalSeconds: 0.5,
    onJobError: (error) => {
      throw error;
    },
    files: createMemoryFileStore(),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    model,
    embeddingModel,
    fetch: async (url) => ({
      url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(
        '<main><h1>Login café 東京</h1><p>Visible knowledge.</p><div style="display:none">knowledge-hidden-display</div><div aria-hidden="true">knowledge-hidden-aria</div><div style="visibility:hidden">knowledge-hidden-visibility</div><pre>reset\n  password</pre></main>',
      ),
    }),
    config: { inboundSecret: secret, dailyTokenBudget: 1_000_000 },
  });
  await server.startWorker();
});
afterAll(async () => {
  await server?.runner.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});
it("drafts an HTML-only API email without its hidden instructions", async () => {
  const app = createApp(server.services, {
    authenticate: async () => ({
      tenantId,
      actor: { type: "agent", id: "fixture" },
      scopes: new Set(["conversations:read"]),
    }),
  });
  const raw = readFileSync(new URL("../../../../fixtures/email/hidden-html.eml", import.meta.url));
  const response = await app.request("/v1/inbound/email", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "message/rfc822" },
    body: raw,
  });
  expect(response.status).toBe(201);
  const { conversationId } = z.object({ conversationId: z.string() }).parse(await response.json());
  await vi.waitFor(
    async () => {
      const drafts = await app.request(`/v1/conversations/${conversationId}/drafts`);
      expect(drafts.status).toBe(200);
      expect(await drafts.json()).toMatchObject({ drafts: [{ status: "pending" }] });
    },
    { timeout: 20_000, interval: 200 },
  );
  expect(model.doGenerateCalls).toHaveLength(1);
  const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
  expect(prompt).toContain("Visible login question & café.");
  expect(prompt).toContain("Visible follow-up.");
  expect(prompt).not.toContain("hidden-display");
  expect(prompt).not.toContain("hidden-aria");
  expect(prompt).not.toContain("hidden-visibility");
});

it("ingests visible knowledge through the API and quotes it in an HTML-only email draft", async () => {
  const app = createApp(server.services, {
    authenticate: async () => ({
      tenantId,
      actor: { type: "agent", id: "fixture" },
      scopes: new Set(["conversations:read", "knowledge:write", "knowledge:read"]),
    }),
  });
  const created = await app.request("/v1/knowledge/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "url", title: "Login", url: "https://docs.example.test/login" }),
  });
  expect(created.status).toBe(201);
  const source = z.object({ id: z.string() }).parse(await created.json());
  await vi.waitFor(
    async () => {
      const response = await app.request("/v1/knowledge/sources");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sources: [{ id: source.id, state: { status: "ready" } }],
      });
    },
    { timeout: 20_000, interval: 200 },
  );
  const embedded = embeddingModel.doEmbedCalls.flatMap((call) => call.values).join("\n");
  expect(embedded).toContain("# Login café 東京\n\nVisible knowledge.");
  expect(embedded).toContain("reset\n  password");
  expect(embedded).not.toContain("knowledge-hidden");
  const raw = readFileSync(new URL("../../../../fixtures/email/hidden-html.eml", import.meta.url))
    .toString()
    .replace("Message-ID: <", "Message-ID: <knowledge-");
  const response = await app.request("/v1/inbound/email", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "message/rfc822" },
    body: raw,
  });
  expect(response.status).toBe(201);
  const { conversationId } = z.object({ conversationId: z.string() }).parse(await response.json());
  await vi.waitFor(
    async () => {
      const drafts = await app.request(`/v1/conversations/${conversationId}/drafts`);
      expect(drafts.status).toBe(200);
      expect(await drafts.json()).toMatchObject({ drafts: [{ status: "pending" }] });
    },
    { timeout: 20_000, interval: 200 },
  );
  const prompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt);
  expect(prompt).toContain("<untrusted_knowledge>");
  expect(prompt).toContain("Login café 東京");
  expect(prompt).toContain("Visible knowledge.");
  expect(prompt).toContain("reset\\n  password");
  expect(prompt).toContain("Visible login question & café.\\nVisible follow-up.");
  expect(prompt).not.toContain("hidden-display");
  expect(prompt).not.toContain("hidden-aria");
  expect(prompt).not.toContain("hidden-visibility");
});
