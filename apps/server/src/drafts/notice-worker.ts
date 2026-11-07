import {
  type AuthStore,
  and,
  desc,
  enqueue,
  eq,
  gt,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.ts";
import { buildDraftNotice, noticeWindowMinutes } from "../outbound-email/draft-notice.ts";
import type { EmailTransport } from "../outbound-email/transport.ts";
import { messageText } from "./html-text.ts";
import { draftNoticeJob } from "./jobs.ts";

const { auditEvents, drafts, mailboxes, memberships, messages, tickets } = schema;

export const noticeWorkerActor = { type: "system", id: "draft-notice" } as const;

/**
 * Queues the "a draft is waiting" notice. Call it in the transaction that saves the pending
 * draft, so the notice is queued only if the draft is saved.
 */
export async function queueDraftNotice(
  tx: TenantTx,
  draft: { tenantId: string; id: string; ticketId: string },
): Promise<void> {
  // No dedupe key: a key would fold this into a job that may already be running and have
  // missed this draft. The window check in the handler, under the ticket lock, dedupes instead.
  await enqueue(tx, draftNoticeJob, { tenantId: draft.tenantId, draftId: draft.id });
}

function mailboxDomain(mailbox: string): string {
  return mailbox.split("@").pop() ?? "localhost";
}

/**
 * A no-reply address on the mailbox's domain that is never the mailbox itself, so answering a
 * notice can't land in the helpdesk and open a ticket.
 */
export function noticeReplyTo(mailbox: string): string {
  const domain = mailboxDomain(mailbox);
  const address = `no-reply@${domain}`;
  return address === mailbox.toLowerCase() ? `no-reply-notices@${domain}` : address;
}

/** Keeps any path in the public URL (e.g. `https://acme.test/helpdesk`), which `/tickets/…` would drop. */
function ticketUrl(publicUrl: string, ticketId: string): string {
  return new URL(
    `tickets/${ticketId}`,
    publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`,
  ).toString();
}

export interface NoticeWorkerDeps {
  transport: EmailTransport;
  auth: Pick<AuthStore, "emailsOf">;
  /** Where the ticket link in the notice points, e.g. `https://help.acme.test`. */
  publicUrl: string;
  logger: Pick<Logger, "info" | "warn">;
}

/** Emails the workspace owners that a draft is waiting for approval. */
export function handleDraftNotice(deps: NoticeWorkerDeps) {
  return async (payload: { tenantId: string; draftId: string }, tx: TenantTx): Promise<void> => {
    const { tenantId, draftId } = payload;
    const [queued] = await tx
      .select({ ticketId: drafts.ticketId })
      .from(drafts)
      .where(eq(drafts.id, draftId));
    if (!queued) {
      deps.logger.warn({ draftId }, "draft-notice: draft not found");
      return;
    }

    // Locks the ticket, so two notice jobs for it can't both see an empty window.
    await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.id, queued.ticketId))
      .for("update");

    // Whatever draft is pending on the ticket now, not only the one this job was queued for:
    // a newer draft can replace it while the job waits. That draft's own job then finds the
    // window taken and sends nothing.
    const [row] = await tx
      .select({
        ticketId: drafts.ticketId,
        mailbox: mailboxes.address,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
      })
      .from(drafts)
      .innerJoin(messages, eq(messages.id, drafts.messageId))
      .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
      .innerJoin(mailboxes, eq(mailboxes.id, tickets.mailboxId))
      .where(and(eq(drafts.ticketId, queued.ticketId), eq(drafts.status, "pending")))
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    // Approved or discarded meanwhile: nothing is waiting any more.
    if (!row) return;

    const [recent] = await tx
      .select({ at: auditEvents.createdAt })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "ticket"),
          eq(auditEvents.targetId, row.ticketId),
          eq(auditEvents.action, "draft.notice_sent"),
          gt(auditEvents.createdAt, sql`now() - make_interval(mins => ${noticeWindowMinutes})`),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    if (recent) {
      // The window batches notices for the same waiting answer. Once a draft on the ticket was
      // approved after that notice, the owners acted on it, so a new draft is news again.
      const [actedOn] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.ticketId, row.ticketId), gt(drafts.approvedAt, recent.at)))
        .limit(1);
      if (!actedOn) return;
    }

    const owners = await tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.role, "owner"));
    const to = await deps.auth.emailsOf(owners.map((o) => o.userId));
    if (to.length === 0) {
      deps.logger.warn({ draftId }, "draft-notice: the workspace has no owner to notify");
      return;
    }

    const domain = mailboxDomain(row.mailbox);
    const raw = await buildDraftNotice({
      from: row.mailbox,
      replyTo: noticeReplyTo(row.mailbox),
      to,
      ticketUrl: ticketUrl(deps.publicUrl, row.ticketId),
      customerText: messageText(row),
      messageId: `<notice-${uuidv7()}@${domain}>`,
      date: new Date(),
    });

    // The audit event first and the send last: if the send fails, the event rolls back with
    // the transaction and pg-boss retries, so a failed send never blocks the next notice.
    await recordAudit(tx, {
      tenantId,
      actor: noticeWorkerActor,
      action: "draft.notice_sent",
      target: { type: "ticket", id: row.ticketId },
      requestId: null,
    });
    await deps.transport.send({ from: row.mailbox, to, raw });
    deps.logger.info({ draftId, ticketId: row.ticketId }, "draft notice sent");
  };
}
