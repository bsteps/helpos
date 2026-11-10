import {
  and,
  desc,
  enqueue,
  eq,
  inArray,
  isNull,
  ne,
  type SQL,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import type { AuditAction, Auditor } from "../audit/audit.ts";
import { sendReplyJob } from "./jobs.ts";
import { queueDraftNotice } from "./notice-worker.ts";

// The one module that writes the drafts table. Routes and workers call the operations below,
// in their own transaction; the draft-writes Biome plugin fails on a drafts insert, update or
// delete anywhere else, so a new status can't be handled in one caller and missed in another.

const { drafts, mailboxes, messages, tickets } = schema;

export type DraftRow = typeof drafts.$inferSelect;
type DraftStatus = schema.DraftStatus;
type DraftKind = schema.DraftKind;

interface Transition {
  /** The statuses a draft may be in for this change. Anything else is a conflict. */
  readonly from: readonly DraftStatus[];
  readonly to: DraftStatus;
  /** Recorded in the same transaction as the change. */
  readonly audit: AuditAction;
}

/**
 * Every way a draft's status changes, and nothing else. A new draft is `pending` (see
 * `createReply` and `createFixedNotice`).
 */
export const draftTransitions = {
  /** A person rewrites the text. Only while nobody has approved it. */
  edit: { from: ["pending"], to: "pending", audit: "draft.edited" },
  /** The only way a reply reaches a customer: the send is queued in the same transaction. */
  approve: { from: ["pending"], to: "approved", audit: "draft.approved" },
  /** A person drops a draft that shouldn't go out, or a send that kept failing. */
  discard: { from: ["pending", "send_failed"], to: "discarded", audit: "draft.discarded" },
  /**
   * Something newer replaced it: a newer reply on the ticket, or the issue a "fixed" notice was
   * about was reopened. Only a pending one: a failed send waits for a person to decide.
   */
  discardStale: { from: ["pending"], to: "discarded", audit: "draft.discarded" },
  /** The send worker handed it to the mail server. */
  markSent: { from: ["approved"], to: "sent", audit: "draft.sent" },
  /** Every send attempt failed, so it waits for a person to retry or discard it. */
  markSendFailed: { from: ["approved"], to: "send_failed", audit: "draft.send_failed" },
  /** Queued to send again, with the Message-ID fixed at approval. */
  retry: { from: ["send_failed"], to: "approved", audit: "draft.send_retried" },
} as const satisfies Record<string, Transition>;

type DraftOperation = keyof typeof draftTransitions;

/**
 * Statuses a draft can still move on from: it is waiting for approval, being sent, or waiting
 * on a person after a failed send. `sent` and `discarded` are final.
 */
export const openStatuses: readonly DraftStatus[] = schema.draftStatuses.filter((status) =>
  Object.values(draftTransitions).some((t) => (t.from as readonly DraftStatus[]).includes(status)),
);

/** What a change to one draft did. `conflict` carries the draft as it is now. */
export type DraftChange =
  | { outcome: "changed"; draft: DraftRow }
  | { outcome: "not_found" }
  | { outcome: "conflict"; draft: DraftRow };

type DraftValues = typeof drafts.$inferInsert;
type DraftSet = { [K in Exclude<keyof DraftValues, "status">]?: DraftValues[K] | SQL };

/**
 * The conditional update every single-draft change goes through: it applies only while the
 * draft is in one of the operation's `from` statuses (and `also`, when given), so two changes
 * at once can't both win. When nothing matched, the draft is read again to tell a missing one
 * (404) from one in another status (409).
 */
async function change(
  tx: TenantTx,
  audit: Auditor,
  operation: DraftOperation,
  id: string,
  set: DraftSet = {},
  also?: SQL,
): Promise<DraftChange> {
  const { from, to, audit: action } = draftTransitions[operation];
  const [changed] = await tx
    .update(drafts)
    .set({ ...set, status: to })
    .where(and(eq(drafts.id, id), inArray(drafts.status, [...from]), also))
    .returning();
  if (!changed) {
    const [current] = await tx.select().from(drafts).where(eq(drafts.id, id));
    return current ? { outcome: "conflict", draft: current } : { outcome: "not_found" };
  }
  await audit(tx, action, { type: "draft", id });
  return { outcome: "changed", draft: changed };
}

/** Queues the send. Its key is the draft, so a send already queued isn't queued twice. */
async function queueSend(tx: TenantTx, draft: DraftRow): Promise<void> {
  await enqueue(
    tx,
    sendReplyJob,
    { tenantId: draft.tenantId, draftId: draft.id },
    { singletonKey: draft.id },
  );
}

export function editDraft(
  tx: TenantTx,
  audit: Auditor,
  id: string,
  body: string,
): Promise<DraftChange> {
  return change(tx, audit, "edit", id, { body });
}

/**
 * Approves a pending draft and queues its send, together: either both commit or neither does.
 * Bound to `reviewedBody`, the exact text the approver saw, so an edit made after review can't
 * ride on the approval (a conflict instead). Fixes the Message-ID every send attempt reuses.
 */
export async function approveDraft(
  tx: TenantTx,
  audit: Auditor,
  id: string,
  reviewedBody: string,
): Promise<DraftChange> {
  const [found] = await tx
    .select({ mailbox: mailboxes.address })
    .from(drafts)
    .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
    .innerJoin(mailboxes, eq(mailboxes.id, tickets.mailboxId))
    .where(eq(drafts.id, id));
  if (!found) return { outcome: "not_found" };
  const domain = found.mailbox.split("@").pop() ?? "localhost";
  const approved = await change(
    tx,
    audit,
    "approve",
    id,
    {
      // The database clock, like the audit events the notice window compares it with.
      approvedAt: sql`now()`,
      outboundMessageIdHeader: `<${uuidv7()}@${domain}>`,
    },
    eq(drafts.body, reviewedBody),
  );
  if (approved.outcome === "changed") await queueSend(tx, approved.draft);
  return approved;
}

export function discardDraft(tx: TenantTx, audit: Auditor, id: string): Promise<DraftChange> {
  return change(tx, audit, "discard", id);
}

/**
 * Queues a `send_failed` draft to send again, back to `approved`. Safe to repeat: a `sent` draft
 * comes back as `already_sent`, and an `approved` one has its send queued again (in case its
 * job was lost: it expired, or the worker died, on the last attempt). The send key returns the
 * live job if there is one, and the worker locks the draft and skips it once sent, so it can't
 * go out twice.
 */
export async function retrySend(
  tx: TenantTx,
  audit: Auditor,
  id: string,
): Promise<DraftChange | { outcome: "already_sent"; draft: DraftRow }> {
  const retried = await change(tx, audit, "retry", id);
  if (retried.outcome === "changed") {
    await queueSend(tx, retried.draft);
    return retried;
  }
  if (retried.outcome === "not_found") return retried;
  const current = retried.draft;
  if (current.status === "sent") return { outcome: "already_sent", draft: current };
  if (current.status !== "approved") return retried;
  await audit(tx, draftTransitions.retry.audit, { type: "draft", id });
  await queueSend(tx, current);
  return { outcome: "changed", draft: current };
}

/** The send worker sent it. Call it with the transaction that stores the outbound message. */
export function markSent(
  tx: TenantTx,
  audit: Auditor,
  id: string,
  sent: { sentAt: Date; sentMessageId: string },
): Promise<DraftChange> {
  return change(tx, audit, "markSent", id, sent);
}

/** Every send attempt failed. A draft sent or changed meanwhile is left alone (a conflict). */
export function markSendFailed(tx: TenantTx, audit: Auditor, id: string): Promise<DraftChange> {
  return change(tx, audit, "markSendFailed", id);
}

/**
 * Discards the tickets' pending drafts of `kind`, auditing each, and returns their IDs. A new
 * reply replaces pending replies (`createReply` does it itself); a reopened issue withdraws the
 * pending "fixed" notice. The two kinds never replace each other: "it's fixed" is still news
 * when the customer writes again.
 */
export async function discardStale(
  tx: TenantTx,
  audit: Auditor,
  where: { ticketIds: string[]; kind: DraftKind },
): Promise<string[]> {
  if (where.ticketIds.length === 0) return [];
  const { from, to, audit: action } = draftTransitions.discardStale;
  const stale = await tx
    .update(drafts)
    .set({ status: to })
    .where(
      and(
        inArray(drafts.ticketId, where.ticketIds),
        eq(drafts.kind, where.kind),
        inArray(drafts.status, [...from]),
      ),
    )
    .returning({ id: drafts.id });
  for (const { id } of stale) await audit(tx, action, { type: "draft", id });
  return stale.map((d) => d.id);
}

/**
 * Locks the ticket for drafting and says which message a draft answers: the ticket's latest
 * message from a person (machine mail is never answered), or null when it has none. Every
 * writer of a ticket's drafts takes this lock first, so two can't both add a live draft, and a
 * slow AI draft can't land after something that happened meanwhile. Null when there's no such
 * ticket in this workspace.
 */
export async function lockTicketForDrafting(
  tx: TenantTx,
  ticketId: string,
): Promise<{ answering: string | null } | null> {
  const [ticket] = await tx
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .for("update");
  if (!ticket) return null;
  const [latest] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.ticketId, ticketId),
        eq(messages.direction, "inbound"),
        isNull(messages.automatedReason),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return { answering: latest?.id ?? null };
}

/**
 * The message's live draft of `kind`, if any: one not discarded (and, for a "fixed" notice, not
 * sent: a fix that didn't hold gets a new notice). The same rule as the unique index, so there
 * is at most one.
 */
export async function liveDraftFor(
  tx: TenantTx,
  messageId: string,
  kind: DraftKind,
): Promise<{ id: string; status: DraftStatus } | undefined> {
  const [live] = await tx
    .select({ id: drafts.id, status: drafts.status })
    .from(drafts)
    .where(
      and(
        eq(drafts.messageId, messageId),
        eq(drafts.kind, kind),
        ne(drafts.status, "discarded"),
        kind === "fixed" ? ne(drafts.status, "sent") : undefined,
      ),
    )
    .limit(1);
  return live;
}

/** Saves a new pending draft, queues the owners' notice, and records it. */
async function insertPending(
  tx: TenantTx,
  audit: Auditor,
  values: {
    tenantId: string;
    ticketId: string;
    messageId: string;
    kind: DraftKind;
    body: string;
    noticeDelaySeconds: number;
  },
): Promise<DraftRow> {
  const { noticeDelaySeconds, ...row } = values;
  const [draft] = await tx.insert(drafts).values(row).returning();
  if (!draft) throw new Error("create draft: insert returned no row");
  await queueDraftNotice(tx, draft, noticeDelaySeconds);
  await audit(tx, "draft.created", { type: "draft", id: draft.id });
  return draft;
}

/**
 * Saves a pending reply to `messageId`, from a person or the AI. The ticket's older pending
 * replies are discarded first, so nobody approves an answer to a question the customer has moved
 * past, and the ticket stops waiting on a paused or failed AI. Call it under
 * `lockTicketForDrafting`, after checking the message has no live reply.
 */
export async function createReply(
  tx: TenantTx,
  audit: Auditor,
  input: {
    tenantId: string;
    ticketId: string;
    messageId: string;
    body: string;
    noticeDelaySeconds: number;
  },
): Promise<DraftRow> {
  await discardStale(tx, audit, { ticketIds: [input.ticketId], kind: "reply" });
  const draft = await insertPending(tx, audit, { ...input, kind: "reply" });
  await tx.update(tickets).set({ aiPausedReason: null }).where(eq(tickets.id, input.ticketId));
  return draft;
}

/**
 * Adds a pending "fixed" notice to the ticket, answering the customer's latest message. Null,
 * with nothing written, when the ticket has no message from a person or already has a "fixed"
 * notice open (waiting, being sent or waiting on a retry), whichever message it answers: the
 * customer is never told twice at once. One already sent (a fix that didn't hold, reopened, now
 * closed again) is no reason not to tell them about this one. A pending reply stays: the two
 * kinds never replace each other.
 */
export async function createFixedNotice(
  tx: TenantTx,
  audit: Auditor,
  input: { tenantId: string; ticketId: string; body: string; noticeDelaySeconds: number },
): Promise<DraftRow | null> {
  const lock = await lockTicketForDrafting(tx, input.ticketId);
  if (!lock?.answering) return null;
  const [open] = await tx
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.ticketId, input.ticketId),
        eq(drafts.kind, "fixed"),
        inArray(drafts.status, [...openStatuses]),
      ),
    )
    .limit(1);
  if (open) return null;
  return insertPending(tx, audit, { ...input, messageId: lock.answering, kind: "fixed" });
}
