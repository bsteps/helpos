import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { mockModel } from "@helpos/ai/testing";
import { createAuthStore, createDatabase, type Database, eq, schema, sql } from "@helpos/db";
import {
  containerHost,
  expireTestSendJob,
  startTestDatabase,
  type TestDatabase,
} from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import type { AuditContext } from "../audit/audit.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import {
  createSmtpTransport,
  type EmailTransport,
  SendRejected,
} from "../outbound-email/transport.ts";
import { composeServer, type Server } from "../server.ts";
import { retryJobsQuickly } from "../testing/quick-retries.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { sendReplyJob } from "./jobs.ts";
import { approveDraft, createReply, retrySend } from "./lifecycle.ts";
import { handleSendGaveUp, handleSendReply } from "./send-worker.ts";

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
let commitFailures = 0;
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
        const result = await db.withTenant(tenantId, fn).catch((error: unknown) => {
          if (error instanceof Error && error.message === "injected COMMIT failure")
            commitFailures++;
          throw error;
        });
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
    },
  });
  await helpos.startWorker();
  await retryJobsQuickly(helpos.runner);
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
  await waitFor(async () => ((await copies(subject)) === 1 ? true : undefined));
  expect(await copies(subject)).toBe(1);
}, 60_000);

it("SMTP accepts, then PostgreSQL rejects COMMIT and the retry sends nothing", async () => {
  const owner = createDatabase(testDb.ownerUrl);
  await owner.withTenant(acme, async (tx) => {
    await tx.execute(
      sql`create function fail_sent_commit() returns trigger language plpgsql as $$ begin raise exception 'injected COMMIT failure'; end $$`,
    );
    await tx.execute(
      sql`create constraint trigger fail_sent_commit after update on drafts deferrable initially deferred for each row when (new.status = 'sent') execute function fail_sent_commit()`,
    );
  });
  try {
    script = ["accept"];
    const { conversationId, subject } = await approvedDraft();
    await waitFor(async () => (commitFailures > 0 ? true : undefined));
    expect((await draftOf(conversationId))?.status).toBe("send_uncertain");
    expect(await copies(subject)).toBe(1);
  } finally {
    await owner.withTenant(acme, async (tx) => {
      await tx.execute(sql`drop trigger fail_sent_commit on drafts`);
      await tx.execute(sql`drop function fail_sent_commit()`);
    });
    await owner.close();
  }
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

it("a killed worker after SMTP acceptance never sends a second copy after lease expiry", async () => {
  const raw = await readFile(
    new URL("../../../../fixtures/email/send-uncertain.eml", import.meta.url),
  );
  await helpos.runner.stop();
  const received = await ingestEmail({ db, files }, raw);
  if (received.kind !== "created") throw new Error(received.kind);
  const payload = await db.withTenant(acme, async (tx) => {
    const context: AuditContext = {
      tenantId: acme,
      actor: { type: "user", id: "crash-test" },
      requestId: null,
    };
    const draft = await createReply(tx, context, {
      tenantId: acme,
      conversationId: received.conversationId,
      messageId: received.messageId,
      body: "Crash replay reply",
      noticeDelaySeconds: 3600,
    });
    await approveDraft(tx, context, draft.id, draft.body);
    return { tenantId: acme, draftId: draft.id };
  });
  const child = fork(new URL("./fixtures/crash-worker.ts", import.meta.url), [], {
    env: {
      ...process.env,
      TEST_APP_URL: testDb.appUrl,
      TEST_JOBS_URL: testDb.jobsUrl,
      TEST_SMTP_URL: `smtp://${containerHost(mailpit)}:${mailpit.getMappedPort(1025)}`,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const stopped = once(child, "exit");
  try {
    const accepted = await once(child, "message");
    expect(accepted[0]).toBe("SMTP accepted");
    child.kill("SIGKILL");
    await stopped;
    expect((await draftOf(received.conversationId))?.status).toBe("send_uncertain");
    expect(await copies("Physical worker crash")).toBe(1);
    await expireTestSendJob(testDb.jobsUrl, payload.draftId);
    const replayed = Promise.withResolvers<void>();
    const sendMail = vi.fn();
    await helpos.runner.start();
    await helpos.runner.work(sendReplyJob, {
      steps: async (job, transaction) => {
        await handleSendReply({
          files,
          logger: { info: vi.fn(), warn: vi.fn() },
          transport: { send: sendMail, close: () => {} },
        })(job, transaction);
        if (job.draftId === payload.draftId) replayed.resolve();
      },
      onGiveUp: handleSendGaveUp,
    });
    await replayed.promise;
    expect(sendMail).not.toHaveBeenCalled();
    expect(await copies("Physical worker crash")).toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await stopped;
    await helpos.runner.stop();
    await helpos.startWorker();
    await retryJobsQuickly(helpos.runner);
  }
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
      retrySend(
        tx,
        { tenantId: acme, actor: { type: "system", id: "replay" }, requestId: null },
        draftId,
      ),
    );
    expect(result.outcome).toBe("changed");
  } finally {
    releaseGiveUp.resolve();
  }
  await helpos.runner.stop();
  expect((await draftOf(conversationId))?.status).toBe("approved");
  expect(await copies(subject)).toBe(0);
}, 60_000);
