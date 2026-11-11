import { mockModel } from "@helpos/ai/testing";
import { createAuthStore, createDatabase, type Database, eq, schema } from "@helpos/db";
import { containerHost, startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { auditorFor } from "../audit/audit.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import {
  createSmtpTransport,
  type EmailTransport,
  SendRejected,
} from "../outbound-email/transport.ts";
import { composeServer, type Server } from "../server.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { retrySend } from "./lifecycle.ts";

type Attempt =
  | "accept"
  | "accept-then-throw"
  | "down"
  | "down-and-give-up-fails"
  | "down-and-pause-give-up";
let script: Attempt[] = [];
let testDb: TestDatabase;
let mailpit: StartedTestContainer;
let mailpitApi: string;
let db: Database;
let helpos: Server;
let smtp: EmailTransport;
let acme: string;
let n = 0;
const files = createMemoryFileStore();
let failGiveUp = false;
let pauseGiveUp = false;
let giveUpCommitted = Promise.withResolvers<void>();
let releaseGiveUp = Promise.withResolvers<void>();
const jobErrors = vi.fn();

beforeAll(async () => {
  [testDb, mailpit] = await Promise.all([
    startTestDatabase(),
    new GenericContainer("axllent/mailpit:v1.27").withExposedPorts(1025, 8025).start(),
  ]);
  mailpitApi = `http://${containerHost(mailpit)}:${mailpit.getMappedPort(8025)}`;
  db = createDatabase(testDb.appUrl);
  smtp = createSmtpTransport(`smtp://${containerHost(mailpit)}:${mailpit.getMappedPort(1025)}`);
  helpos = composeServer({
    db: {
      ...db,
      withTenant: async (tenantId, fn) => {
        if (failGiveUp) {
          failGiveUp = false;
          throw new Error("give-up transaction unavailable");
        }
        const pause = pauseGiveUp;
        pauseGiveUp = false;
        const result = await db.withTenant(tenantId, fn);
        if (pause) {
          giveUpCommitted.resolve();
          await releaseGiveUp.promise;
        }
        return result;
      },
    },
    jobsUrl: testDb.jobsUrl,
    pollingIntervalSeconds: 0.5,
    onJobError: jobErrors,
    files,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    model: mockModel({ text: "Thanks, we are on it." }),
    transport: {
      send: async (message) => {
        const step = script.shift() ?? "accept";
        if (step === "down-and-pause-give-up") {
          pauseGiveUp = true;
          throw new SendRejected("SMTP down");
        }
        if (step === "down") throw new SendRejected("SMTP down");
        if (step === "down-and-give-up-fails") {
          failGiveUp = true;
          throw new SendRejected("SMTP down");
        }
        await smtp.send(message);
        if (step === "accept-then-throw")
          throw new Error("the transaction fails after SMTP accepted");
      },
      close: () => {},
    },
    auth: createAuthStore(testDb.authUrl),
    config: {
      publicUrl: "http://helpdesk.test",
      noticeDelaySeconds: 3600,
      dailyTokenBudget: 1_000_000,
      jobRetry: { limit: 1, delaySeconds: 1, backoff: false },
    },
  });
  await helpos.startWorker();
  const a = await initWorkspace(
    { db, auth: createAuthStore(testDb.authUrl) },
    { workspace: "Acme", mailbox: "support@acme.test", owner: "owner@acme.test" },
  );
  if (!a.ok) throw new Error("setup failed");
  acme = a.tenantId;
  await db.withTenant(acme, (tx) =>
    tx
      .update(schema.tenants)
      .set({ shadowMode: false, shadowRecipient: null })
      .where(eq(schema.tenants.id, acme)),
  );
}, 180_000);

afterAll(async () => {
  await helpos?.runner.stop();
  await Promise.all([testDb?.stop(), mailpit?.stop()]);
});

async function approvedDraft() {
  n++;
  const subject = `Replay ${n}`;
  const raw = [
    "From: Jane <jane@customer.test>",
    "To: support@acme.test",
    `Subject: ${subject}`,
    `Message-ID: <replay-${n}@customer.test>`,
    "",
    "Where is my order?",
  ].join("\r\n");
  const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
  if (result.kind !== "created") throw new Error(result.kind);
  const pending = await waitFor(async () =>
    (await draftOf(result.conversationId))?.status === "pending"
      ? await draftOf(result.conversationId)
      : undefined,
  );
  const app = createApp(helpos.services, {
    authenticate: async () => ({
      tenantId: acme,
      actor: { type: "agent", id: "replay" },
      scopes: new Set(["conversations:read", "drafts:write", "drafts:approve"] as const),
    }),
  });
  const res = await app.request(`/v1/drafts/${pending.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: pending.body }),
  });
  expect(res.status).toBe(200);
  return { conversationId: result.conversationId, subject, draftId: pending.id };
}

const draftOf = async (conversationId: string) =>
  (
    await db.withTenant(acme, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, conversationId)),
    )
  )[0];
async function copies(subject: string) {
  const res = await fetch(`${mailpitApi}/api/v1/messages`);
  const { messages } = (await res.json()) as { messages: { Subject: string }[] };
  return messages.filter((m) => m.Subject === `Re: ${subject}`).length;
}
async function waitFor<T>(fn: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

it("#130 NoResendWithoutPerson: SmtpAccepts, TransactionCommitFails, retry, SmtpAccepts", async () => {
  script = ["accept-then-throw", "accept"];
  const { conversationId, subject } = await approvedDraft();
  await waitFor(async () =>
    (await draftOf(conversationId))?.status === "send_uncertain" ? true : undefined,
  );
  await waitFor(async () => ((await copies(subject)) === 1 ? true : undefined));
  expect(await copies(subject)).toBe(1);
}, 60_000);

it("#130 NoHiddenDelivery: SmtpAccepts, TransactionCommitFails, retry, SmtpRejects, GiveUpMarksFailed", async () => {
  script = ["accept-then-throw", "down"];
  const { conversationId, subject } = await approvedDraft();
  await waitFor(async () =>
    (await draftOf(conversationId))?.status === "send_uncertain" ? true : undefined,
  );
  expect(await copies(subject)).toBe(1);
}, 60_000);

it("Give-up failure NoSilentStall: SmtpRejects, retry, SmtpRejects, GiveUpFails", async () => {
  script = ["down", "down-and-give-up-fails"];
  const { conversationId } = await approvedDraft();
  await waitFor(async () =>
    jobErrors.mock.calls.some(
      ([error]) => error instanceof Error && error.message === "give-up transaction unavailable",
    )
      ? true
      : undefined,
  );
  expect((await draftOf(conversationId))?.status).toBe("approved");
}, 60_000);

it("retry between give-up commit and job settlement is lost", async () => {
  giveUpCommitted = Promise.withResolvers<void>();
  releaseGiveUp = Promise.withResolvers<void>();
  script = ["down", "down-and-pause-give-up"];
  const { conversationId, draftId, subject } = await approvedDraft();
  try {
    await giveUpCommitted.promise;
    expect((await draftOf(conversationId))?.status).toBe("send_failed");
    const result = await db.withTenant(acme, (tx) =>
      retrySend(tx, auditorFor(acme, { type: "system", id: "replay" }), draftId),
    );
    expect(result.outcome).toBe("changed");
  } finally {
    releaseGiveUp.resolve();
  }
  await helpos.runner.stop();
  expect((await draftOf(conversationId))?.status).toBe("approved");
  expect(await copies(subject)).toBe(0);
}, 60_000);
