import { readFileSync } from "node:fs";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  schema,
  tenantTransactions,
} from "@helpos/db";
import { containerHost, startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import PostalMime from "postal-mime";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { handleSendReply } from "../drafts/send-worker.ts";
import { ensureJobQueues } from "../jobs.ts";
import { createSmtpTransport, type EmailTransport } from "../outbound-email/transport.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/email/issue-208/${name}`, import.meta.url));
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const secret = "issue-208-inbound-secret";
let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let mailpit: StartedTestContainer;
let smtp: EmailTransport;
let mailpitApi: string;
let tenantId: string;
const app = () =>
  createApp(composeServices({ db, files, logger, config: { inboundSecret: secret } }), {
    authenticate: async () => ({
      tenantId,
      actor: { type: "agent", id: "fixture-author" },
      scopes: new Set(["conversations:read", "drafts:write", "drafts:approve"]),
    }),
  });
const received = z.object({
  status: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
});
async function post(raw: Uint8Array) {
  const response = await app().request("/v1/inbound/email", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "message/rfc822" },
    body: raw,
  });
  expect(response.status).toBe(201);
  return received.parse(await response.json());
}
async function message(id: string) {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.messages).where(eq(schema.messages.id, id)),
  );
  if (!row) throw new Error(`Missing message ${id}`);
  return row;
}
function call(path: string, body: object) {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  [testDb, mailpit] = await Promise.all([
    startTestDatabase(),
    new GenericContainer("axllent/mailpit:v1.27").withExposedPorts(1025, 8025).start(),
  ]);
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await runner.start();
  await ensureJobQueues(runner, defaultConfig);
  const workspace = await initWorkspace(
    { db, auth },
    { workspace: "Email fixtures", mailbox: "support@acme.test", owner: "owner@acme.test" },
  );
  if (!workspace.ok) throw new Error("Workspace setup failed");
  tenantId = workspace.tenantId;
  mailpitApi = `http://${containerHost(mailpit)}:${mailpit.getMappedPort(8025)}`;
  smtp = createSmtpTransport(`smtp://${containerHost(mailpit)}:${mailpit.getMappedPort(1025)}`);
});
afterAll(async () => {
  await runner?.stop();
  smtp?.close();
  await db?.close();
  await auth?.close();
  await Promise.all([testDb?.stop(), mailpit?.stop()]);
});

it.each([
  {
    name: "latin1",
    subject: "Café",
    text: "Crème brûlée coûte 5 livres.",
    html: null,
    encoded: "Cr=E8me",
  },
  {
    name: "windows1252",
    subject: "Windows receipt",
    text: "“Merci” — 20 €.",
    html: null,
    encoded: "=93Merci=94",
  },
  {
    name: "html-only",
    subject: "HTML receipt",
    text: null,
    html: "<p>Merci pour le café.</p>",
    encoded: "caf=C3=A9",
  },
])(
  "stores decoded $name and preserves its original MIME bytes",
  async ({ name, subject, text, html, encoded }) => {
    const raw = fixture(`${name}.eml`);
    expect(raw.toString("ascii")).toContain(encoded);
    const result = await post(raw);
    expect(result.status).toBe("created");
    const row = await message(result.messageId);
    expect(row.subject).toBe(subject);
    expect(row.textBody?.trim() ?? null).toBe(text);
    expect(row.htmlBody?.trim() ?? null).toBe(html);
    expect(files.files.get(row.rawFileKey)).toEqual(new Uint8Array(raw));
    const [conversation] = await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, result.conversationId)),
    );
    expect(conversation?.subject).toBe(subject);
  },
);

it("keeps a forwarded RFC822 as attachment bytes, not a separate inbound conversation", async () => {
  const raw = fixture("forwarded.eml");
  const result = await post(raw);
  const row = await message(result.messageId);
  expect(row.textBody?.trim()).toBe("Please see the attached receipt.");
  expect(row.messageIdHeader).toBe("<208-forward@customer.test>");
  expect(files.files.get(row.rawFileKey)).toEqual(new Uint8Array(raw));
  const attachments = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.attachments).where(eq(schema.attachments.messageId, row.id)),
  );
  expect(attachments).toHaveLength(1);
  const attachment = attachments[0];
  expect(attachment).toMatchObject({
    filename: "receipt.eml",
    contentType: "message/rfc822",
    sizeBytes: fixture("forwarded-inner.eml").length,
  });
  expect(files.files.get(attachment?.fileKey ?? "")).toEqual(
    new Uint8Array(fixture("forwarded-inner.eml")),
  );
  const nested = await db.withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.messageIdHeader, "<208-inner@customer.test>")),
  );
  expect(nested).toEqual([]);
});

it("accepts identical deliveries without Message-ID separately instead of guessing identity from content", async () => {
  const raw = fixture("no-message-id.eml");
  expect(raw.toString()).not.toMatch(/^Message-ID:/im);
  const first = await post(raw);
  const retry = await post(raw);
  expect([first.status, retry.status]).toEqual(["created", "created"]);
  expect(retry.conversationId).not.toBe(first.conversationId);
  expect(retry.messageId).not.toBe(first.messageId);
  for (const result of [first, retry]) {
    const row = await message(result.messageId);
    expect(row.messageIdHeader).toBeNull();
    expect(row.textBody?.trim()).toBe("Please help with the same question.");
    expect(files.files.get(row.rawFileKey)).toEqual(new Uint8Array(raw));
  }
});

it.each([false, true])(
  "sends non-ASCII MIME through SMTP with shadow mode %s, then threads replies to its stored outbound ID",
  async (shadowMode) => {
    await db.withTenant(tenantId, (tx) =>
      tx
        .update(schema.tenants)
        .set({ shadowMode, shadowRecipient: "owner@acme.test" })
        .where(eq(schema.tenants.id, tenantId)),
    );
    const source = fixture("outbound-source.eml")
      .toString()
      .replace("208-source@", `208-source-${shadowMode}@`);
    const inbound = await post(Buffer.from(source));
    const body = fixture("reply.txt").toString().trim();
    const created = await call(`/v1/conversations/${inbound.conversationId}/drafts`, { body });
    expect(created.status).toBe(201);
    const draft = z.object({ id: z.string() }).parse(await created.json());
    const approved = await call(`/v1/drafts/${draft.id}/approve`, { body });
    expect(approved.status).toBe(200);
    const envelopes: { from: string; to: string[]; raw: Uint8Array }[] = [];
    await handleSendReply({
      files,
      logger,
      transport: {
        send: async (envelope) => {
          envelopes.push(envelope);
          await smtp.send(envelope);
        },
        close: () => {},
      },
    })({ tenantId, draftId: draft.id }, tenantTransactions(db, tenantId));
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    if (!envelope) throw new Error("Missing SMTP envelope");
    const recipient = shadowMode ? "owner@acme.test" : "jane@customer.test";
    expect(envelope.from).toBe("support@acme.test");
    expect(envelope.to).toEqual([recipient]);
    const decoded = await PostalMime.parse(envelope.raw);
    expect(decoded.subject).toContain("Re: Café — 東京");
    expect(decoded.text).toContain(body);
    expect(decoded.to?.map((address) => address.address)).toEqual([recipient]);
    expect(Buffer.from(envelope.raw).toString()).toMatch(/Subject: =\?UTF-8\?/i);
    const [sent] = await db.withTenant(tenantId, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.id, draft.id)),
    );
    expect(sent?.status).toBe("sent");
    if (!sent?.sentMessageId || !sent.outboundMessageIdHeader)
      throw new Error("Missing sent reply");
    const outbound = await message(sent.sentMessageId);
    expect(outbound.messageIdHeader).toBe(decoded.messageId);
    expect(outbound.toAddresses).toEqual([recipient]);
    expect(files.files.get(outbound.rawFileKey)).toEqual(envelope.raw);
    expect(decoded.inReplyTo).toBe(`<208-source-${shadowMode}@customer.test>`);
    expect(decoded.references).toBe(decoded.inReplyTo);
    const listing = z
      .object({ messages: z.array(z.object({ ID: z.string(), MessageID: z.string() })) })
      .parse(await (await fetch(`${mailpitApi}/api/v1/messages`)).json());
    const delivered = listing.messages.find(
      (mail) => mail.MessageID === sent.outboundMessageIdHeader?.slice(1, -1),
    );
    expect(delivered).toBeDefined();
    const rawResponse = await fetch(`${mailpitApi}/api/v1/message/${delivered?.ID}/raw`);
    expect(rawResponse.status).toBe(200);
    const deliveredMime = await PostalMime.parse(await rawResponse.arrayBuffer());
    expect(deliveredMime.messageId).toBe(decoded.messageId);
    expect(deliveredMime.subject).toBe(decoded.subject);
    expect(deliveredMime.text).toBe(decoded.text);
    expect(deliveredMime.to).toEqual(decoded.to);
    for (const name of ["reply-to-outbound", "references-only"]) {
      const raw = fixture(`${name}.eml`)
        .toString()
        .replaceAll("<OUTBOUND-ID>", sent.outboundMessageIdHeader)
        .replace(/(Message-ID: <[^>]+)@customer.test>/, `$1-${shadowMode}@customer.test>`);
      const reply = await post(Buffer.from(raw));
      expect(reply).toMatchObject({ status: "threaded", conversationId: inbound.conversationId });
      const stored = await message(reply.messageId);
      expect(stored.inReplyTo).toBe(
        name === "references-only" ? null : sent.outboundMessageIdHeader,
      );
    }
  },
);
