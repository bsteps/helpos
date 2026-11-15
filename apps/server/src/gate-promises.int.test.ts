import { mockModel } from "@helpos/ai/testing";
import { createAuthStore, createDatabase, eq, schema, tenantTransactions } from "@helpos/db";
import { startTestDatabase, waitFor, waitForTenantJobs } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import PostalMime from "postal-mime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import type { Principal, Scope } from "./auth/principal.ts";
import { sendReplyJob } from "./drafts/jobs.ts";
import { handleSendGaveUp, handleSendReply } from "./drafts/send-worker.ts";
import { ingestEmail } from "./inbound-email/ingest.ts";
import { ensureJobQueues } from "./jobs.ts";
import type { EmailTransport } from "./outbound-email/transport.ts";
import { composeServer } from "./server.ts";
import { waitsFor } from "./testing/waits-for.ts";
import { initWorkspace } from "./workspaces/init-workspace.ts";

// The gate's promises (threat model G4 to G7) against real Postgres, through the
// public API. Kept promises are plain tests. A promise an open issue has not built yet uses
// waitsFor(): it pins today's outcome, and fails with instructions once the guard lands.
// A gate has no worker unless a test starts one, so no job moves a draft mid-scenario.

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

const drafting: Scope[] = ["conversations:read", "drafts:write"];
const approving: Scope[] = ["conversations:read", "drafts:approve"];

/** One workspace on its own database, with the API in front of it and an email recorder behind it. */
async function startGate() {
  const files = createMemoryFileStore();
  const testDb = await startTestDatabase();
  const db = createDatabase(testDb.appUrl);
  const auth = createAuthStore(testDb.authUrl);
  const server = composeServer({
    db,
    auth,
    jobsUrl: testDb.jobsUrl,
    files,
    logger,
    model: mockModel({ text: "Reply" }),
    config: { publicUrl: "http://helpdesk.test" },
  });
  await server.runner.start();
  await ensureJobQueues(server.runner, { jobRetry: { limit: 0, delaySeconds: 0, backoff: false } });
  const workspace = await initWorkspace(
    { db, auth },
    { workspace: "Gate", mailbox: "support@gate.test", owner: "owner@gate.test" },
  );
  if (!workspace.ok) throw new Error("workspace setup failed");
  const { tenantId } = workspace;
  // Shadow mode would send to the owner; the promises are about what the customer gets.
  await db.withTenant(tenantId, (tx) =>
    tx.update(schema.tenants).set({ shadowMode: false }).where(eq(schema.tenants.id, tenantId)),
  );

  const delivered: { to: string; text: string }[] = [];
  const transport: EmailTransport = {
    send: async ({ to, raw }) => {
      const email = await PostalMime.parse(raw);
      delivered.push({ to: to.join(","), text: (email.text ?? "").trim() });
    },
    close: () => {},
  };

  function principal(type: "agent" | "user", id: string, scopes: Scope[]): () => Principal {
    return () => ({ tenantId, actor: { type, id }, scopes: new Set(scopes) });
  }
  /** The bearer value names a principal, as in drafts.int.test.ts. */
  const principals: Record<string, () => Principal> = {
    agentA: principal("agent", "agent-a", drafting),
    agentB: principal("agent", "agent-b", drafting),
    agentAWithApprove: principal("agent", "agent-a", [...drafting, "drafts:approve"]),
    personA: principal("user", "person-a", approving),
    personB: principal("user", "person-b", approving),
  };
  const app = createApp(server.services, {
    authenticate: async (req) =>
      principals[req.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""]?.() ?? null,
  });

  async function call(method: string, path: string, as: keyof typeof principals, body: object) {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
      body: JSON.stringify(body),
    });
    const reply = (await res.json()) as { id?: string; error?: string };
    return { ...reply, status: res.status };
  }

  let sequence = 0;
  /** A customer email to the workspace, alone or as a reply in an existing thread. */
  async function receive(customer: string, replyTo?: string) {
    sequence++;
    const header = `<gate-${sequence}@customer.test>`;
    const raw = [
      `From: ${customer}`,
      "To: support@gate.test",
      `Subject: Gate question ${sequence}`,
      `Message-ID: ${header}`,
      ...(replyTo ? [`In-Reply-To: ${replyTo}`, `References: ${replyTo}`] : []),
      "",
      "Hello, I need help.",
    ].join("\r\n");
    const result = await ingestEmail({ db, files }, new TextEncoder().encode(raw));
    if (result.kind !== "created") throw new Error(`ingest: ${result.kind}`);
    return { conversationId: result.conversationId, header };
  }

  return {
    testDb,
    call,
    receive,
    /** A conversation with one pending draft, written by agent A. */
    async pendingDraft(body: string) {
      const customer = `customer-${sequence + 1}@customer.test`;
      const email = await receive(customer);
      const draft = await call(
        "POST",
        `/v1/conversations/${email.conversationId}/drafts`,
        "agentA",
        {
          body,
        },
      );
      if (draft.status !== 201 || !draft.id) throw new Error(`draft: ${draft.status}`);
      return { ...email, customer, draftId: draft.id, body };
    },
    async draftRow(draftId: string) {
      const [row] = await db.withTenant(tenantId, (tx) =>
        tx.select().from(schema.drafts).where(eq(schema.drafts.id, draftId)),
      );
      if (!row) throw new Error("draft vanished");
      return row;
    },
    /** Rewrites a draft's stored text behind the API's back. */
    tamper: (draftId: string, body: string) =>
      db.withTenant(tenantId, (tx) =>
        tx.update(schema.drafts).set({ body }).where(eq(schema.drafts.id, draftId)),
      ),
    auditActions: async (draftId: string) =>
      (
        await db.withTenant(tenantId, (tx) =>
          tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, draftId)),
        )
      ).map((event) => event.action),
    /** Runs the send once, as the send job does, against the recorder. */
    runSend: (draftId: string) =>
      handleSendReply({ transport, files, logger })(
        { tenantId, draftId },
        tenantTransactions(db, tenantId),
      ),
    /** Starts the real send job, against the recorder, and waits until its queue is quiet. */
    async sendQueued(customer: string) {
      await server.runner.work(sendReplyJob, {
        steps: handleSendReply({ transport, files, logger }),
        onGiveUp: handleSendGaveUp,
      });
      await waitFor("the customer's email", async () =>
        delivered.some((mail) => mail.to === customer) ? true : undefined,
      );
      const queue = await waitForTenantJobs(testDb, tenantId, { queues: [sendReplyJob.queue] });
      expect(queue.deferred).toEqual([]);
    },
    deliveredTo: (customer: string) =>
      delivered.filter((mail) => mail.to === customer).map((mail) => mail.text),
    async stop() {
      await server.runner.stop();
      await db.close();
      await auth.close();
      await testDb.stop();
    },
  };
}
type Gate = Awaited<ReturnType<typeof startGate>>;

let gate: Gate;
let sending: Gate;
beforeAll(async () => {
  [gate, sending] = await Promise.all([startGate(), startGate()]);
}, 180_000);
afterAll(async () => {
  await Promise.all([gate?.stop(), sending?.stop()]);
});

describe("one owner per conversation (G6, #165)", () => {
  waitsFor(165, "two agents writing to one conversation at once: one is refused", async () => {
    const email = await gate.receive("customer-owner@customer.test");
    const path = `/v1/conversations/${email.conversationId}/drafts`;
    const results = await Promise.all([
      gate.call("POST", path, "agentA", { body: "From agent A" }),
      gate.call("POST", path, "agentB", { body: "From agent B" }),
    ]);
    return {
      observed: results.map((r) => r.status).sort(),
      today: [201, 201],
      promised: [201, 409],
    };
  });

  waitsFor(165, "an approval of a draft the customer has moved past is refused", async () => {
    const draft = await gate.pendingDraft("Reply to the first message");
    await gate.receive(draft.customer, draft.header);
    const approval = await gate.call("POST", `/v1/drafts/${draft.draftId}/approve`, "personA", {
      body: draft.body,
    });
    return { observed: approval.status, today: 200, promised: 409 };
  });
});

describe("agents propose, people decide (G4, #13)", () => {
  waitsFor(13, "an agent token holding drafts:approve cannot approve", async () => {
    const draft = await gate.pendingDraft("An agent's own draft");
    const approval = await gate.call(
      "POST",
      `/v1/drafts/${draft.draftId}/approve`,
      "agentAWithApprove",
      {
        body: draft.body,
      },
    );
    return {
      observed: { status: approval.status, error: approval.error ?? null },
      today: { status: 200, error: null },
      promised: { status: 403, error: "session_required" },
    };
  });
});

describe("approved means exactly that action (G5, #189)", () => {
  it("an edit racing an approval never changes what was approved or sent", async () => {
    for (let i = 0; i < 10; i++) {
      const draft = await gate.pendingDraft(`Reviewed text ${i}`);
      const edited = `Edited text ${i}`;
      const [edit, approval] = await Promise.all([
        gate.call("PATCH", `/v1/drafts/${draft.draftId}`, "agentA", { body: edited }),
        gate.call("POST", `/v1/drafts/${draft.draftId}/approve`, "personA", { body: draft.body }),
      ]);
      const row = await gate.draftRow(draft.draftId);
      await gate.runSend(draft.draftId);
      if (approval.status === 200) {
        expect([edit.status, row.status, row.body]).toEqual([409, "approved", draft.body]);
        expect(gate.deliveredTo(draft.customer)).toEqual([draft.body]);
      } else {
        expect([approval.status, edit.status, row.status, row.body]).toEqual([
          409,
          200,
          "pending",
          edited,
        ]);
        expect(row.approvedAt).toBeNull();
        expect(gate.deliveredTo(draft.customer)).toEqual([]);
      }
    }
  });

  waitsFor(189, "a draft changed after approval is not sent", async () => {
    const draft = await gate.pendingDraft("The text the person approved");
    const approval = await gate.call("POST", `/v1/drafts/${draft.draftId}/approve`, "personA", {
      body: draft.body,
    });
    expect(approval.status).toBe(200);
    const tampered = "Different text, changed after approval";
    await gate.tamper(draft.draftId, tampered);
    await gate.runSend(draft.draftId);
    return {
      observed: gate.deliveredTo(draft.customer),
      today: [tampered],
      promised: [],
    };
  });
});

describe("nothing is resent on its own (G7)", () => {
  it("two people approving one draft at once send exactly one email", async () => {
    const draft = await sending.pendingDraft("Approved by two people at once");
    const approvals = await Promise.all([
      sending.call("POST", `/v1/drafts/${draft.draftId}/approve`, "personA", { body: draft.body }),
      sending.call("POST", `/v1/drafts/${draft.draftId}/approve`, "personB", { body: draft.body }),
    ]);
    expect(approvals.map((a) => a.status).sort()).toEqual([200, 409]);

    await sending.sendQueued(draft.customer);

    expect(sending.deliveredTo(draft.customer)).toEqual([draft.body]);
    expect((await sending.draftRow(draft.draftId)).status).toBe("sent");
    expect(
      (await sending.auditActions(draft.draftId)).filter((action) => action === "draft.approved"),
    ).toHaveLength(1);
  });
});
