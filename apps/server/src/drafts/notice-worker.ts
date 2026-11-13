import { messageText } from "@helpos/ai/html-text";
import {
  type AuthStore,
  and,
  asc,
  desc,
  enqueue,
  eq,
  gt,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import { builtInActors } from "@helpos/db/actor";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.ts";
import {
  composeEmail,
  mailboxDomain,
  noticeReplyTo,
  outboundMessageId,
} from "../outbound-email/composer.ts";
import { noticeWindowMinutes } from "../outbound-email/draft-notice.ts";
import type { EmailTransport } from "../outbound-email/transport.ts";
import type { ServerConfig } from "../services.ts";
import { draftNoticeJob } from "./jobs.ts";
import { draftWhere } from "./lifecycle.ts";

const { auditEvents, drafts, mailboxes, memberships, messages, conversations } = schema;

export const noticeWorkerActor = builtInActors.noticeWorker;

/**
 * Queues the "a draft is waiting" notice, `delaySeconds` from now (`noticeDelaySeconds`): a
 * draft approved within that time never causes an email. Call it in the transaction that saves
 * the pending draft, so the notice is queued only if the draft is saved.
 */
export async function queueDraftNotice(
  tx: TenantTx,
  draft: { tenantId: string; id: string; conversationId: string },
  delaySeconds: number,
): Promise<void> {
  // No dedupe key: a key would fold this into a job that may already be running and have
  // missed this draft. The window check in the handler, under the conversation lock, dedupes instead.
  await enqueue(
    tx,
    draftNoticeJob,
    { tenantId: draft.tenantId, draftId: draft.id },
    { startAfter: new Date(Date.now() + delaySeconds * 1000) },
  );
}

/** Keeps any path in the public URL (e.g. `https://acme.test/helpdesk`), which `/conversations/…` would drop. */
function conversationUrl(publicUrl: string, conversationId: string): string {
  return new URL(
    `conversations/${conversationId}`,
    publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`,
  ).toString();
}

export interface NoticeWorkerDeps {
  transport: EmailTransport;
  auth: Pick<AuthStore, "emailsOf">;
  logger: Pick<Logger, "info" | "warn">;
  /**
   * `publicUrl`: where the conversation link in the notice points, e.g. `https://help.acme.test`.
   * `noticeDelaySeconds`: the delay the notice was queued with. A younger draft is left to its
   * own job.
   */
  config: Pick<ServerConfig, "noticeDelaySeconds" | "publicUrl">;
}

/**
 * Runs once every attempt to send a notice failed (the mail server stayed down). The draft
 * itself still waits in the inbox; the audit event on its conversation records that the owners were
 * not told. Nothing is recorded for a draft that is no longer waiting.
 */
export async function handleNoticeGaveUp(
  payload: { tenantId: string; draftId: string },
  tx: TenantTx,
): Promise<void> {
  const [draft] = await tx
    .select({ conversationId: drafts.conversationId })
    .from(drafts)
    .where(and(eq(drafts.id, payload.draftId), draftWhere.pending()));
  if (!draft) return;
  await recordAudit(tx, {
    tenantId: payload.tenantId,
    actor: noticeWorkerActor,
    action: "draft.notice_failed",
    details: { draftId: payload.draftId },
    target: { type: "conversation", id: draft.conversationId },
    requestId: null,
  });
}

/** Emails the workspace owners that a draft is waiting for approval. */
export function handleDraftNotice(deps: NoticeWorkerDeps) {
  return async (payload: { tenantId: string; draftId: string }, tx: TenantTx): Promise<void> => {
    const { tenantId, draftId } = payload;
    const delaySeconds = deps.config.noticeDelaySeconds;
    const [queued] = await tx
      .select({ conversationId: drafts.conversationId })
      .from(drafts)
      .where(eq(drafts.id, draftId));
    if (!queued) {
      deps.logger.warn({ draftId }, "draft-notice: draft not found");
      return;
    }

    // Locks the conversation, so two notice jobs for it can't both see an empty window.
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, queued.conversationId))
      .for("update");

    // Whatever draft is pending on the conversation now, not only the one this job was queued for:
    // a newer draft can replace it while the job waits. That draft's own job then finds the
    // window taken and sends nothing.
    const [row] = await tx
      .select({
        id: drafts.id,
        conversationId: drafts.conversationId,
        mailbox: mailboxes.address,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
      })
      .from(drafts)
      .innerJoin(messages, eq(messages.id, drafts.messageId))
      .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
      .innerJoin(mailboxes, eq(mailboxes.id, conversations.mailboxId))
      .where(
        and(
          eq(drafts.conversationId, queued.conversationId),
          draftWhere.pending(),
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
        .where(and(eq(drafts.conversationId, queued.conversationId), draftWhere.pending()))
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
          eq(auditEvents.targetType, "conversation"),
          eq(auditEvents.targetId, row.conversationId),
          eq(auditEvents.action, "draft.notice_sent"),
          gt(auditEvents.createdAt, sql`now() - make_interval(mins => ${noticeWindowMinutes})`),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    if (recent) {
      // The window batches notices for the same waiting answer. Once a draft on the conversation was
      // approved after that notice, the owners acted on it, so a new draft is news again.
      // A discard doesn't count: a replacement draft is the same waiting answer, reworded.
      const [actedOn] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(eq(drafts.conversationId, row.conversationId), draftWhere.wasApproved(recent.at)),
        )
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
    const date = new Date();
    // One email per owner, so owners don't see each other's addresses.
    const notices = await Promise.all(
      to.map(async (owner) => ({
        to: owner,
        raw: await composeEmail({
          kind: "draft_notice",
          from: row.mailbox,
          replyTo: noticeReplyTo(row.mailbox),
          to: owner,
          conversationUrl: conversationUrl(deps.config.publicUrl, row.conversationId),
          customerText: messageText(row),
          messageId: outboundMessageId({ kind: "draft_notice", domain, id: uuidv7() }),
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
      details: { draftId: row.id },
      target: { type: "conversation", id: row.conversationId },
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
    deps.logger.info({ draftId, conversationId: row.conversationId }, "draft notice sent");
  };
}
