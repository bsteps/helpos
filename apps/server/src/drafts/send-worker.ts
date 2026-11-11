import { eq, schema, type TenantTx, uuidv7 } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import type { Logger } from "pino";
import { auditorFor } from "../audit/audit.ts";
import { planDelivery } from "../outbound-email/shadow.ts";
import { buildReply, type EmailTransport, replySubject } from "../outbound-email/transport.ts";
import { markSendFailed, markSent } from "./lifecycle.ts";
import { noticeReplyTo } from "./notice-worker.ts";

const { customers, drafts, mailboxes, messages, tenants, conversations } = schema;

export interface SendWorkerDeps {
  transport: EmailTransport;
  files: FileStore;
  logger: Pick<Logger, "info" | "warn">;
}

const sendWorkerActor = { type: "system", id: "send-reply" } as const;

/**
 * Runs once every send attempt has failed: the draft is marked `send_failed`, so it shows up
 * for someone to retry or discard instead of staying `approved` forever. A draft that was
 * sent or changed meanwhile is left alone.
 */
export async function handleSendGaveUp(
  payload: { tenantId: string; draftId: string },
  tx: TenantTx,
): Promise<void> {
  await markSendFailed(tx, auditorFor(payload.tenantId, sendWorkerActor), payload.draftId);
}

/**
 * Sends one approved draft as a threaded reply, from the workspace mailbox to the customer, or
 * in shadow mode to the shadow recipient instead. The only code that sends replies. A draft
 * that isn't `approved` is never sent.
 */
export function handleSendReply(deps: SendWorkerDeps) {
  return async (payload: { tenantId: string; draftId: string }, tx: TenantTx): Promise<void> => {
    const { tenantId, draftId } = payload;
    const [row] = await tx
      .select({
        draft: drafts,
        inbound: {
          messageIdHeader: messages.messageIdHeader,
          references: messages.references,
          subject: messages.subject,
        },
        mailbox: mailboxes.address,
        customer: customers.email,
        shadow: { shadowMode: tenants.shadowMode, shadowRecipient: tenants.shadowRecipient },
      })
      .from(drafts)
      .innerJoin(messages, eq(messages.id, drafts.messageId))
      .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
      .innerJoin(mailboxes, eq(mailboxes.id, conversations.mailboxId))
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .innerJoin(tenants, eq(tenants.id, drafts.tenantId))
      .where(eq(drafts.id, draftId))
      // Locks the draft, so two workers can't both send it.
      .for("update", { of: drafts });
    if (!row) {
      deps.logger.warn({ draftId }, "send-reply: draft not found");
      return;
    }
    const { draft, inbound } = row;
    if (draft.status === "sent") return; // a retry after a send that committed
    if (draft.status !== "approved" || !draft.outboundMessageIdHeader) {
      deps.logger.warn({ draftId, status: draft.status }, "send-reply: draft is not approved");
      return;
    }

    const now = new Date();
    const subject = replySubject(inbound.subject);
    const references = inbound.messageIdHeader
      ? [...inbound.references, inbound.messageIdHeader]
      : inbound.references;
    const delivery = planDelivery(
      {
        from: row.mailbox,
        to: row.customer,
        subject,
        text: draft.body,
        messageId: draft.outboundMessageIdHeader,
        inReplyTo: inbound.messageIdHeader,
        references,
        date: now,
      },
      { ...row.shadow, shadowReplyTo: noticeReplyTo(row.mailbox) },
    );
    if (delivery.kind === "no_recipient") {
      // Thrown, not skipped: the draft stays approved and pg-boss retries, so it goes out once
      // a shadow recipient is set (or it ends up `send_failed`, to retry once one is). It must
      // never fall through to the customer.
      throw new Error("send-reply: shadow mode is on but no shadow recipient is set");
    }
    const { email } = delivery;
    const raw = await buildReply(email);

    // Database writes first and the send last: if the send fails, the transaction rolls back,
    // the draft stays `approved` and pg-boss retries.
    const rawFileKey = `${tenantId}/${uuidv7()}`;
    await deps.files.put(rawFileKey, raw);
    const sentMessageId = uuidv7();
    await tx.insert(messages).values({
      id: sentMessageId,
      tenantId,
      conversationId: draft.conversationId,
      direction: "outbound",
      fromAddress: row.mailbox,
      // Who really got it: in shadow mode, the shadow recipient, never the customer.
      toAddresses: [email.to],
      subject,
      textBody: email.text,
      messageIdHeader: draft.outboundMessageIdHeader,
      inReplyTo: inbound.messageIdHeader,
      references,
      rawFileKey,
      sentAt: now,
    });
    const sent = await markSent(tx, auditorFor(tenantId, sendWorkerActor), draftId, {
      sentAt: now,
      sentMessageId,
    });
    if (sent.outcome !== "changed") throw new Error("send-reply: draft changed while sending");
    await tx
      .update(conversations)
      .set({ lastMessageAt: now })
      .where(eq(conversations.id, draft.conversationId));

    await deps.transport.send({ from: row.mailbox, to: [email.to], raw });
    deps.logger.info(
      { draftId, conversationId: draft.conversationId, shadow: delivery.kind === "shadow" },
      "reply sent",
    );
  };
}
