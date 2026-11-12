import {
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  schema,
} from "@helpos/db";
import { type Actor, builtInActors } from "@helpos/db/actor";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AuditContext } from "../audit/audit.ts";
import { ingestEmail } from "../inbound-email/ingest.ts";
import { ensureJobQueues } from "../jobs.ts";
import { initWorkspace } from "../workspaces/init-workspace.ts";
import { createFixedNotice, createReply, discardStale, editDraft } from "./lifecycle.ts";

let testDb: TestDatabase;
let db: Database;
let runner: JobRunner;
let tenantId: string;
let otherTenantId: string;
const files = createMemoryFileStore();
let sequence = 0;
const onError = vi.fn();

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  runner = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError });
  await runner.start();
  await ensureJobQueues(runner, { jobRetry: undefined });
  const auth = createAuthStore(testDb.authUrl);
  try {
    for (const mailbox of ["actors", "other"]) {
      const workspace = await initWorkspace(
        { db, auth },
        { workspace: mailbox, mailbox: `${mailbox}@actor.test`, owner: `${mailbox}@owner.test` },
      );
      if (!workspace.ok) throw new Error("workspace setup failed");
      if (mailbox === "actors") tenantId = workspace.tenantId;
      else otherTenantId = workspace.tenantId;
    }
  } finally {
    await auth.close();
  }
});

afterAll(async () => {
  await runner?.stop();
  expect(onError).not.toHaveBeenCalled();
  await db?.close();
  await testDb?.stop();
});

async function receive() {
  const received = await ingestEmail(
    { db, files },
    new TextEncoder().encode(
      [
        "From: customer@actor.test",
        "To: actors@actor.test",
        `Message-ID: <actor-${++sequence}@actor.test>`,
        "Subject: Actor attribution",
        "",
        "Hello",
      ].join("\r\n"),
    ),
  );
  if (received.kind !== "created") throw new Error(received.kind);
  return {
    tenantId,
    conversationId: received.conversationId,
    messageId: received.messageId,
    body: "Reply",
    noticeDelaySeconds: 3600,
  };
}

it.each([
  { type: "user", id: "person" },
  { type: "agent", id: "token" },
  builtInActors.draftWorker,
] satisfies Actor[])(
  "attributes nested lifecycle changes to the supplied $type actor",
  async (actor) => {
    const input = await receive();
    const context: AuditContext = { tenantId, actor, requestId: "actor-request" };
    const ids = await db.withTenant(tenantId, async (tx) => {
      const first = await createReply(tx, context, input);
      const second = await createReply(tx, context, input);
      expect((await editDraft(tx, context, second.id, "Edited")).outcome).toBe("changed");
      const fixed = await createFixedNotice(tx, context, input);
      expect(fixed).not.toBeNull();
      expect(
        await discardStale(tx, context, {
          conversationIds: [input.conversationId],
          kind: "reply",
          details: { reason: "manual", operation: "regenerate" },
        }),
      ).toEqual([second.id]);
      return [first.id, second.id, fixed?.id];
    });
    const audit = await db.withTenant(tenantId, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.requestId, context.requestId ?? "")),
    );
    const ownEvents = audit.filter((event) => ids.includes(event.targetId));
    expect(ownEvents.map((event) => event.action).sort()).toEqual([
      "draft.created",
      "draft.created",
      "draft.created",
      "draft.discarded",
      "draft.discarded",
      "draft.edited",
    ]);
    expect(ownEvents).toHaveLength(6);
    for (const event of ownEvents) {
      expect(event).toMatchObject({
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        requestId: context.requestId,
      });
    }
  },
);

it("rolls back the draft when its supplied audit tenant is outside the transaction", async () => {
  const input = await receive();
  await expect(
    db.withTenant(tenantId, (tx) =>
      createReply(
        tx,
        {
          tenantId: otherTenantId,
          actor: builtInActors.draftWorker,
          requestId: null,
        },
        input,
      ),
    ),
  ).rejects.toThrow();
  expect(
    await db.withTenant(tenantId, (tx) =>
      tx.select().from(schema.drafts).where(eq(schema.drafts.conversationId, input.conversationId)),
    ),
  ).toEqual([]);
});
