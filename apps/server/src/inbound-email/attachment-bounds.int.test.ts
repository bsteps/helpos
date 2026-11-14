import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageText } from "@helpos/ai/html-text";
import { createAuthStore, createDatabase, createJobRunner, eq, schema } from "@helpos/db";
import { startTestDatabase } from "@helpos/db/testing";
import { createLocalFileStore } from "@helpos/files";
import PostalMime from "postal-mime";
import { expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { maxAttachments, maxFilenameLength, parseEmail } from "./parse.ts";

const fixture = Buffer.from(
  (
    await readFile(
      new URL("../../../../fixtures/email/attachment-limit.eml", import.meta.url),
      "utf8",
    )
  ).replace(/\r?\n/g, "\r\n"),
);

it("stores only the first 20 attachments, bounded names, and a visible note through the API", async () => {
  expect((await PostalMime.parse(fixture)).attachments).toHaveLength(maxAttachments + 1);
  const testDb = await startTestDatabase();
  const db = createDatabase(testDb.appUrl);
  const auth = createAuthStore(testDb.authUrl);
  const directory = await mkdtemp(join(tmpdir(), "attachment-bounds-"));
  const files = createLocalFileStore(directory);
  const put = vi.spyOn(files, "put");
  const runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  try {
    await runner.start();
    await ensureJobQueues(runner);
    const workspace = await initWorkspace(
      { db, auth },
      {
        workspace: "Attachments",
        mailbox: "support@acme.test",
        owner: "owner@acme.test",
      },
    );
    if (!workspace.ok) throw new Error("Workspace setup failed");
    const { tenantId } = workspace;
    const app = createApp(
      composeServices({
        db,
        files,
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
        config: { inboundSecret: "attachment-test" },
      }),
      {
        authenticate: async () => ({
          tenantId,
          actor: { type: "agent", id: "fixture" },
          scopes: new Set(["conversations:read"]),
        }),
      },
    );
    const post = () =>
      app.request("/v1/inbound/email", {
        method: "POST",
        headers: { authorization: "Bearer attachment-test", "content-type": "message/rfc822" },
        body: fixture,
      });
    const response = await post();
    expect(response.status).toBe(201);
    const rows = await db.withTenant(tenantId, (tx) => tx.select().from(schema.messages));
    expect(rows).toHaveLength(1);
    const message = rows[0];
    if (!message) throw new Error("Message missing");
    const attachments = await db.withTenant(tenantId, (tx) =>
      tx.select().from(schema.attachments).where(eq(schema.attachments.messageId, message.id)),
    );
    expect(attachments).toHaveLength(20);
    expect(put).toHaveBeenCalledTimes(21);
    expect(await readdir(join(directory, tenantId))).toHaveLength(21);
    expect(await files.get(message.rawFileKey)).toEqual(new Uint8Array(fixture));
    expect(attachments.map((a) => a.filename)).toContain("x".repeat(255));
    expect(attachments.map((a) => a.filename)).not.toContain("log-20.txt");
    for (const attachment of attachments) {
      expect(Array.from(attachment.filename ?? "").length).toBeLessThanOrEqual(255);
      expect(await files.get(attachment.fileKey)).toEqual(
        new TextEncoder().encode(
          attachment.filename === "x".repeat(255)
            ? "log 0"
            : `log ${attachment.filename?.match(/\d+/)?.[0]}`,
        ),
      );
    }
    const detail = await app.request(`/v1/conversations/${message.conversationId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      messages: [{ text: expect.stringContaining("1 attachment(s) omitted") }],
    });
    expect(message.textBody).toContain("Please check these logs.");
    expect((await post()).status).toBe(200);
    expect(put).toHaveBeenCalledTimes(21);
    const htmlResponse = await app.request("/v1/inbound/email", {
      method: "POST",
      headers: { authorization: "Bearer attachment-test", "content-type": "message/rfc822" },
      body: fixture
        .toString()
        .replace("<attachment-limit@", "<attachment-limit-html@")
        .replace("text/plain; charset=utf-8", "text/html; charset=utf-8")
        .replace(
          "Please check these logs.",
          "<html><body><p>Visible document.</p><p hidden>Hidden document.</p></body></html>",
        ),
    });
    expect(htmlResponse.status).toBe(201);
    const htmlMessages = await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.messageIdHeader, "<attachment-limit-html@customer.test>")),
    );
    const htmlMessage = htmlMessages[0];
    if (!htmlMessage) throw new Error("HTML message missing");
    const htmlDetail = await app.request(`/v1/conversations/${htmlMessage.conversationId}`);
    expect(htmlDetail.status).toBe(200);
    expect(await htmlDetail.json()).toMatchObject({
      messages: [
        {
          html: null,
          text: expect.stringMatching(/1 attachment\(s\) omitted[\s\S]*Visible document\./),
        },
      ],
    });
    expect(htmlMessage.textBody).not.toContain("Hidden document.");
  } finally {
    await runner.stop();
    await db.close();
    await auth.close();
    await testDb.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains exactly-at-cap mail without an omission note", async () => {
  const raw = fixture
    .toString()
    .replace(
      /--attachment-limit\r\nContent-Type: application\/octet-stream\r\nContent-Disposition: attachment; filename="log-20.txt"\r\n\r\nlog 20\r\n/,
      "",
    );
  const email = await parseEmail(new TextEncoder().encode(raw));
  expect(email.attachments).toHaveLength(maxAttachments);
  expect(email.text).not.toContain("omitted");
});

it("keeps the note and visible HTML-only text without exposing hidden text", async () => {
  const raw = fixture
    .toString()
    .replace("text/plain; charset=utf-8", "text/html; charset=utf-8")
    .replace("Please check these logs.", "<p>Visible logs.</p><div hidden>hidden instruction");
  const email = await parseEmail(new TextEncoder().encode(raw));
  expect(email.html).toBeNull();
  expect(email.text).toMatch(/^Attachment limit reached:/);
  const text = messageText({ textBody: email.text, htmlBody: email.html });
  expect(text).toContain("1 attachment(s) omitted");
  expect(text).toContain("Visible logs.");
  expect(text).not.toContain("hidden instruction");
});

it("bounds decoded Unicode filenames without splitting a code point", async () => {
  const filename = "😀".repeat(maxFilenameLength + 1);
  const raw = fixture
    .toString()
    .replace(/filename="x+\.txt"/, `filename*=utf-8''${encodeURIComponent(filename)}`);
  const email = await parseEmail(new TextEncoder().encode(raw));
  expect(email.attachments[0]?.filename).toBe("😀".repeat(maxFilenameLength));
});

it("shows the note and body for a full HTML document with a blank text alternative", async () => {
  const body = [
    "--attachment-limit",
    'Content-Type: multipart/alternative; boundary="alternatives"',
    "",
    "--alternatives",
    "Content-Type: text/plain",
    "",
    "   ",
    "--alternatives",
    "Content-Type: text/html",
    "",
    '<html><head><title>Title</title></head><body><p>Visible document.</p><p style="display:none">Hidden document.</p></body></html>',
    "--alternatives--",
  ].join("\r\n");
  const raw = fixture
    .toString()
    .replace(
      "--attachment-limit\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease check these logs.",
      body,
    );
  const email = await parseEmail(new TextEncoder().encode(raw));
  expect(email.html).toBeNull();
  expect(email.text).toContain("1 attachment(s) omitted");
  expect(email.text).toContain("Visible document.");
  expect(email.text).not.toContain("Hidden document.");
});
