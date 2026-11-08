import {
  type AuthStore,
  and,
  asc,
  desc,
  enqueue,
  eq,
  gt,
  lte,
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
 * How long a draft waits before its notice is sent. A draft approved within this time never
 * causes an email: only drafts someone is actually leaving waiting do.
 */
export const defaultNoticeDelaySeconds = 300;

/**
 * Queues the "a draft is waiting" notice. Call it in the transaction that saves the pending
 * draft, so the notice is queued only if the draft is saved.
 */
export async function queueDraftNotice(
  tx: TenantTx,
  draft: { tenantId: string; id: string; ticketId: string },
  delaySeconds = defaultNoticeDelaySeconds,
): Promise<void> {
  // No dedupe key: a key would fold this into a job that may already be running and have
  // missed this draft. The window check in the handler, under the ticket lock, dedupes instead.
  await enqueue(
    tx,
    draftNoticeJob,
    { tenantId: draft.tenantId, draftId: draft.id },
    { startAfter: new Date(Date.now() + delaySeconds * 1000) },
  );
}

function mailboxDomain(mailbox: string): string {
  return mailbox.split("@").pop() ?? "localhost";
}

/**
 * A no-reply address on the mailbox's domain that is never the mailbox itself, so answering a
 * notice can't land in the helpdesk and open a ticket.
 */
export function noticeReplyTo(mailbox: string): string {
  const domain = mailboxDomain(mailbox).toLowerCase();
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
  /** The same delay the notice was queued with. A younger draft is left to its own job. */
  noticeDelaySeconds?: number;
}

/** Emails the workspace owners that a draft is waiting for approval. */
export function handleDraftNotice(deps: NoticeWorkerDeps) {
  return async (payload: { tenantId: string; draftId: string }, tx: TenantTx): Promise<void> => {
    const { tenantId, draftId } = payload;
    const delaySeconds = deps.noticeDelaySeconds ?? defaultNoticeDelaySeconds;
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
        kind: drafts.kind,
        createdAt: drafts.createdAt,
        mailbox: mailboxes.address,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
      })
      .from(drafts)
      .innerJoin(messages, eq(messages.id, drafts.messageId))
      .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
      .innerJoin(mailboxes, eq(mailboxes.id, tickets.mailboxId))
      .where(
        and(
          eq(drafts.ticketId, queued.ticketId),
          eq(drafts.status, "pending"),
          // A draft that hasn't waited the full delay yet may still be approved in time. Its own
          // job, queued with it, runs once it has.
          sql`${drafts.createdAt} <= now() - make_interval(secs => ${delaySeconds})`,
        ),
      )
      .orderBy(desc(drafts.createdAt))
      .limit(1);
    if (!row) {
      // A pending draft that is still too young means this job ran early: the queue's delay is
      // set from the app's clock, the age check uses the database's. Run again once it's old
      // enough, at a time taken from the database clock, so it isn't skipped for good.
      const [young] = await tx
        .select({
          id: drafts.id,
          readyAt: sql<Date>`${drafts.createdAt} + make_interval(secs => ${delaySeconds})`.mapWith(
            (v: string | Date) => new Date(v),
          ),
        })
        .from(drafts)
        .where(and(eq(drafts.ticketId, queued.ticketId), eq(drafts.status, "pending")))
        .orderBy(asc(drafts.createdAt))
        .limit(1);
      if (young) {
        await enqueue(
          tx,
          draftNoticeJob,
          { tenantId, draftId: young.id },
          { startAfter: young.readyAt },
        );
      }
      // Otherwise it was approved or discarded meanwhile: nothing is waiting any more.
      return;
    }

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
      // A discard doesn't count: a replacement draft is the same waiting answer, reworded.
      const [actedOn] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.ticketId, row.ticketId), gt(drafts.approvedAt, recent.at)))
        .limit(1);
      // A kind of draft the ticket didn't have at that notice is other news: "it's fixed"
      // waiting is not the reply the owners were already told about (nor the other way round).
      // A reworded draft of a kind it had is the same news.
      const [sameKindBefore] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(
            eq(drafts.ticketId, row.ticketId),
            eq(drafts.kind, row.kind),
            lte(drafts.createdAt, recent.at),
          ),
        )
        .limit(1);
      const otherNews = row.createdAt > recent.at && !sameKindBefore;
      if (!actedOn && !otherNews) return;
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
    const date = new Date();
    // One email per owner, so owners don't see each other's addresses.
    const notices = await Promise.all(
      to.map(async (owner) => ({
        to: owner,
        raw: await buildDraftNotice({
          from: row.mailbox,
          replyTo: noticeReplyTo(row.mailbox),
          to: owner,
          ticketUrl: ticketUrl(deps.publicUrl, row.ticketId),
          customerText: messageText(row),
          messageId: `<notice-${uuidv7()}@${domain}>`,
          date,
        }),
      })),
    );

    // The audit event first and the send last: if the send fails, the event rolls back with
    // the transaction and pg-boss retries, so a failed send never blocks the next notice.
    await recordAudit(tx, {
      tenantId,
      actor: noticeWorkerActor,
      action: "draft.notice_sent",
      target: { type: "ticket", id: row.ticketId },
      requestId: null,
    });
    // One owner's failed address mustn't resend the notice to owners it already reached. Only
    // when nobody got it does the job fail and retry.
    const results = await Promise.allSettled(
      notices.map((notice) =>
        deps.transport.send({ from: row.mailbox, to: [notice.to], raw: notice.raw }),
      ),
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length === results.length) throw failed[0]?.reason;
    if (failed.length > 0) {
      deps.logger.warn(
        { draftId, failed: failed.length, total: results.length },
        "draft-notice: some owners could not be reached",
      );
    }
    deps.logger.info({ draftId, ticketId: row.ticketId }, "draft notice sent");
  };
}
