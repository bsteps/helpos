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
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices, defaultConfig } from "../services.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { ingestEmail } from "./ingest.ts";
import { maxEmailBytes, secretMatches } from "./route.ts";

const secret = "s".repeat(40);
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/email/${name}`, import.meta.url));

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let acme: string;
let other: string;
const files = createMemoryFileStore();
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const app = () =>
  createApp(composeServices({ db, files, logger, config: { inboundSecret: secret } }));

function post(body: Uint8Array | string, authorization: string | null = `Bearer ${secret}`) {
  const headers: Record<string, string> = { "content-type": "message/rfc822" };
  if (authorization) headers.authorization = authorization;
  return app().request("/v1/inbound/email", { method: "POST", headers, body });
}

async function postFixture(name: string) {
  const res = await post(fixture(name));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  // Ingest queues a draft job, and enqueue() needs the queue to exist. Nothing works it here.
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
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

beforeEach(() => vi.clearAllMocks());

describe("POST /v1/inbound/email: authentication", () => {
  it.each([
    ["missing", null],
    ["wrong", "Bearer wrong-secret"],
    ["not a bearer", secret],
  ])("returns 401 for a %s secret, and stores nothing", async (_, authorization) => {
    const before = files.files.size;
    const res = await post(fixture("plain.eml"), authorization);
    expect(res.status).toBe(401);
    expect(files.files.size).toBe(before);
  });

  it("refuses everything when no secret is configured", async () => {
    const res = await createApp(composeServices({ db, files, logger })).request(
      "/v1/inbound/email",
      { method: "POST", headers: { authorization: "Bearer " }, body: fixture("plain.eml") },
    );
    expect(res.status).toBe(401);
  });

  it("secretMatches compares exactly", () => {
    expect(secretMatches(secret, `Bearer ${secret}`)).toBe(true);
    expect(secretMatches(secret, `Bearer ${secret}x`)).toBe(false);
    expect(secretMatches(undefined, "Bearer ")).toBe(false);
  });
});

describe("POST /v1/inbound/email: email → conversation", () => {
  let janeConversation = "";

  it("plain: creates a customer, a conversation and a message, and keeps the raw MIME", async () => {
    const { status, body } = await postFixture("plain.eml");
    expect(status).toBe(201);
    expect(body.status).toBe("created");
    janeConversation = body.conversationId ?? "";

    const [conversation] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.id, janeConversation)),
    );
    expect(conversation?.subject).toBe("Cannot log in");
    const [customer] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.customers)
        .where(eq(schema.customers.id, conversation?.customerId ?? "")),
    );
    expect(customer).toMatchObject({ email: "jane@customer.test", name: "Jane Customer" });
    const [message] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, body.messageId ?? "")),
    );
    expect(message?.textBody).toContain("I cannot log in");
    expect(message?.rawFileKey.startsWith(`${acme}/`)).toBe(true);
    expect(files.files.get(message?.rawFileKey ?? "")).toEqual(
      new Uint8Array(fixture("plain.eml")),
    );
  });

  it("reply: threads onto the same conversation via In-Reply-To", async () => {
    const { status, body } = await postFixture("reply.eml");
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: "threaded", conversationId: janeConversation });
  });

  it("duplicate delivery: stores nothing new and points at the first copy", async () => {
    const before = await db.withTenant(acme, (tx) => tx.select().from(schema.messages));
    const { status, body } = await postFixture("plain.eml");
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "duplicate", conversationId: janeConversation });
    const after = await db.withTenant(acme, (tx) => tx.select().from(schema.messages));
    expect(after).toHaveLength(before.length);
  });

  it("two concurrent deliveries of one email store it once", async () => {
    const raw = fixture("plain.eml").toString().replace("<plain-1@", "<race-1@");
    const results = await Promise.all([post(raw), post(raw), post(raw)]);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as {
      status: string;
      messageId: string;
    }[];
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(bodies.filter((b) => b.status !== "duplicate")).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.messageId)).size).toBe(1);
    const stored = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.messageIdHeader, "<race-1@customer.test>")),
    );
    expect(stored).toHaveLength(1);
  });

  it("a later email can't rename an existing customer", async () => {
    const raw = fixture("plain.eml")
      .toString()
      .replace("Jane Customer", "Not Jane")
      .replace("<plain-1@", "<rename-1@");
    expect((await post(raw)).status).toBe(201);
    const [customer] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.email, "jane@customer.test")),
    );
    expect(customer?.name).toBe("Jane Customer");
  });

  it("a reply from a different sender starts a new conversation instead of joining", async () => {
    const { status, body } = await postFixture("reply-from-stranger.eml");
    expect(status).toBe(201);
    expect(body.status).toBe("created");
    expect(body.conversationId).not.toBe(janeConversation);
  });

  it("html: stores the HTML as received and decodes the subject", async () => {
    const { body } = await postFixture("html.eml");
    const [message] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, body.messageId ?? "")),
    );
    expect(message?.subject).toBe("Order №12");
    expect(message?.textBody?.trim()).toBe("Where is my order?");
    // Stored untouched; whoever renders it must sanitise it (#46).
    expect(message?.htmlBody).toContain("<script>");
  });

  it("attachment: stores metadata in the table and bytes under a generated key", async () => {
    const { body } = await postFixture("attachment.eml");
    const rows = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.attachments)
        .where(eq(schema.attachments.messageId, body.messageId ?? "")),
    );
    expect(rows).toHaveLength(1);
    const [attachment] = rows;
    // The hostile filename is kept as data only; it never becomes a path.
    expect(attachment).toMatchObject({
      filename: "../../etc/passwd",
      contentType: "text/plain",
      sizeBytes: 11,
    });
    expect(attachment?.fileKey).toMatch(new RegExp(`^${acme}/[0-9a-f-]{36}$`));
    expect(new TextDecoder().decode(files.files.get(attachment?.fileKey ?? ""))).toBe(
      "hello world",
    );
  });

  it("prompt injection: is stored as plain data and triggers nothing", async () => {
    const { status, body } = await postFixture("prompt-injection.eml");
    expect(status).toBe(201);
    const [message] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, body.messageId ?? "")),
    );
    expect(message?.textBody).toContain("ignore all previous instructions");
  });

  it("unknown mailbox: 404, and nothing is stored", async () => {
    const filesBefore = files.files.size;
    const res = await post(fixture("unknown-mailbox.eml"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_mailbox" });
    expect(files.files.size).toBe(filesBefore);
    for (const tenant of [acme, other]) {
      const found = await db.withTenant(tenant, (tx) =>
        tx
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.messageIdHeader, "<unknown-1@customer.test>")),
      );
      expect(found).toEqual([]);
    }
  });

  it("missing From: 422", async () => {
    expect((await postFixture("missing-from.eml")).status).toBe(422);
  });

  it("too large: 413 and logged, before anything is parsed", async () => {
    const res = await post(new Uint8Array(maxEmailBytes + 1));
    expect(res.status).toBe(413);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe("POST /v1/inbound/email: tenant isolation", () => {
  it("mail to another workspace's address lands only in that workspace", async () => {
    const raw = fixture("plain.eml")
      .toString()
      .replace("support@acme.test", "help@other.test")
      .replace("<plain-1@", "<to-other-1@");
    const res = await post(raw);
    expect(res.status).toBe(201);
    const { conversationId } = (await res.json()) as { conversationId: string };

    const inOther = await db.withTenant(other, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)),
    );
    const inAcme = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)),
    );
    expect(inOther).toHaveLength(1);
    expect(inAcme).toEqual([]);
  });

  it("the same Message-ID in two workspaces is two separate messages", async () => {
    const raw = fixture("plain.eml").toString().replace("support@acme.test", "help@other.test");
    const res = await post(raw);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { status: string }).status).toBe("created");
  });
});

describe("automated mail: out-of-office, bounces, lists", () => {
  const normal = (id = "<normal-auto-test@") =>
    new Uint8Array(Buffer.from(fixture("plain.eml").toString().replace("<plain-1@", id)));

  it.each([
    ["out-of-office.eml", "auto_submitted"],
    ["bounce.eml", "system_sender"],
    ["mailing-list.eml", "precedence"],
  ])("%s is stored as automated and never gets a draft", async (name, reason) => {
    const result = await ingestEmail({ db, files }, new Uint8Array(fixture(name)));
    if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
    expect(result.draftReply).toBe(false);

    const [message] = await db.withTenant(acme, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.id, result.messageId)),
    );
    expect(message?.automatedReason).toBe(reason);
    if (!result.threaded) {
      const [conversation] = await db.withTenant(acme, (tx) =>
        tx
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, result.conversationId)),
      );
      expect(conversation?.automated).toBe(true);
    }
  });

  it("an automated reply does not reopen a closed conversation", async () => {
    const first = await ingestEmail({ db, files }, normal("<closed-1@"));
    if (first.kind !== "created") throw new Error(`expected created, got ${first.kind}`);
    await db.withTenant(acme, (tx) =>
      tx
        .update(schema.conversations)
        .set({ status: "closed" })
        .where(eq(schema.conversations.id, first.conversationId)),
    );
    const ooo = fixture("out-of-office.eml")
      .toString()
      .replace("<ooo-1@", "<ooo-closed@")
      .replace("Auto-Submitted", "In-Reply-To: <closed-1@customer.test>\nAuto-Submitted");
    const reply = await ingestEmail({ db, files }, new Uint8Array(Buffer.from(ooo)));
    if (reply.kind !== "created") throw new Error(`expected created, got ${reply.kind}`);
    expect(reply).toMatchObject({ threaded: true, draftReply: false });
    const [conversation] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, first.conversationId)),
    );
    expect(conversation?.status).toBe("closed");
  });

  it("a person replying on an automated conversation makes it a normal conversation", async () => {
    const human = fixture("plain.eml")
      .toString()
      .replace("<plain-1@", "<human-2@")
      .replace("From: Jane Customer <Jane@Customer.test>", "From: Pat <pat@customer.test>");
    const opened = fixture("out-of-office.eml")
      .toString()
      .replace("<ooo-1@", "<ooo-pat@")
      .replace("From: Jane Customer <jane@customer.test>", "From: Pat <pat@customer.test>");
    const auto = await ingestEmail({ db, files }, new Uint8Array(Buffer.from(opened)));
    if (auto.kind !== "created") throw new Error(`expected created, got ${auto.kind}`);
    const followUp = await ingestEmail(
      { db, files },
      new Uint8Array(
        Buffer.from(human.replace("Subject:", "In-Reply-To: <ooo-pat@customer.test>\nSubject:")),
      ),
    );
    expect(followUp).toMatchObject({ kind: "created", threaded: true, draftReply: true });
    const [conversation] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, auto.conversationId)),
    );
    expect(conversation?.automated).toBe(false);
  });

  it("a normal email is the only one that asks for a draft", async () => {
    const result = await ingestEmail({ db, files }, normal());
    if (result.kind !== "created") throw new Error(`expected created, got ${result.kind}`);
    expect(result.draftReply).toBe(true);
    const [conversation] = await db.withTenant(acme, (tx) =>
      tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, result.conversationId)),
    );
    expect(conversation?.automated).toBe(false);
  });
});

describe("GET /openapi.json", () => {
  it("documents the inbound email route", async () => {
    const res = await app().request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(spec.paths["/v1/inbound/email"]?.post).toBeDefined();
  });
});
