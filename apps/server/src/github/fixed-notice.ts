import { and, desc, eq, inArray, isNull, schema, type TenantTx } from "@helpos/db";
import { type AuditActor, recordAudit } from "../audit/audit.ts";
import { queueDraftNotice } from "../drafts/notice-worker.ts";

const { drafts, messages, tickets } = schema;

/**
 * What the customer is told when their issue is fixed. A fixed text, not AI: it says nothing
 * from the issue (which may be in a private repo, and whose text anyone with access can
 * write), and a human reads and can edit it before approving, like any reply.
 */
export const fixedNoticeBody = [
  "Hello,",
  "",
  "Good news: the problem you reported to us has been fixed.",
  "",
  "Thank you for letting us know, and sorry for the trouble. If you still see it, just reply to this email and we'll take another look.",
].join("\n");

export const githubWebhookActor = { type: "system", id: "github-webhook" } as const;

/**
 * Adds a pending "fixed" draft to the ticket, as a reply to the customer's latest message, and
 * queues the owners' "a draft is waiting" notice. Nothing is sent: it waits for approval, and
 * the send worker then applies shadow mode like for any reply. Does nothing when the ticket
 * has no message from a person, or already has a "fixed" draft waiting or being sent.
 */
export async function addFixedDraft(
  tx: TenantTx,
  input: {
    tenantId: string;
    ticketId: string;
    actor: AuditActor;
    requestId: string | null;
    noticeDelaySeconds?: number | undefined;
  },
): Promise<{ draftId: string } | null> {
  const { tenantId, ticketId } = input;
  // The same lock drafting takes, so this and a reply being written can't trip over each other.
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
  if (!latest) return null;
  const [existing] = await tx
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.messageId, latest.id),
        eq(drafts.kind, "fixed"),
        // One sent already (a fix that didn't hold, reopened, now closed again) is no reason
        // not to tell the customer about this one.
        inArray(drafts.status, ["pending", "approved"]),
      ),
    );
  if (existing) return null;

  const [draft] = await tx
    .insert(drafts)
    .values({ tenantId, ticketId, messageId: latest.id, kind: "fixed", body: fixedNoticeBody })
    .returning();
  if (!draft) throw new Error("fixed draft: insert returned no row");
  await queueDraftNotice(tx, draft, input.noticeDelaySeconds);
  await recordAudit(tx, {
    tenantId,
    actor: input.actor,
    action: "draft.created",
    target: { type: "draft", id: draft.id },
    requestId: input.requestId,
  });
  return { draftId: draft.id };
}
