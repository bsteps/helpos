import type { TenantTx } from "@helpos/db";
import { type Actor, builtInActors } from "@helpos/db/actor";
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

export const githubWebhookActor = builtInActors.githubWebhook;

/**
 * Adds a pending "fixed" draft to the conversation, as a reply to the customer's latest message, and
 * queues the owners' "a draft is waiting" notice. Nothing is sent: it waits for approval, and
 * the send worker then applies shadow mode like for any reply. Does nothing when the conversation
 * has no message from a person, or already has a "fixed" draft waiting or being sent.
 */
export async function addFixedDraft(
  tx: TenantTx,
  input: {
    tenantId: string;
    conversationId: string;
    actor: Actor;
    requestId: string | null;
    noticeDelaySeconds: number;
  },
): Promise<{ draftId: string } | null> {
  const draft = await createFixedNotice(
    tx,
    { tenantId: input.tenantId, actor: input.actor, requestId: input.requestId },
    {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      body: fixedNoticeBody,
      noticeDelaySeconds: input.noticeDelaySeconds,
    },
  );
  return draft && { draftId: draft.id };
}
