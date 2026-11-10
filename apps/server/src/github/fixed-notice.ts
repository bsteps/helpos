import type { TenantTx } from "@helpos/db";
import { type AuditActor, auditorFor } from "../audit/audit.ts";
import { createFixedNotice } from "../drafts/lifecycle.ts";

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
    noticeDelaySeconds: number;
  },
): Promise<{ draftId: string } | null> {
  const draft = await createFixedNotice(
    tx,
    auditorFor(input.tenantId, input.actor, input.requestId),
    {
      tenantId: input.tenantId,
      ticketId: input.ticketId,
      body: fixedNoticeBody,
      noticeDelaySeconds: input.noticeDelaySeconds,
    },
  );
  return draft && { draftId: draft.id };
}
