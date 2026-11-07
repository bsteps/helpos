import { and, eq, schema, type TenantTx, uuidv7 } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.ts";
import { buildReply, type EmailTransport, replySubject } from "../outbound-email/transport.ts";

const { customers, drafts, mailboxes, messages, tickets } = schema;

export interface SendWorkerDeps {
  transport: EmailTransport;
  files: FileStore;
  logger: Pick<Logger, "info" | "warn">;
}

export const sendWorkerActor = { type: "system", id: "send-reply" } as const;

/**
 * Sends one approved draft as a threaded reply, from the workspace mailbox to the customer.
 * The only code that sends email. A draft that isn't `approved` is never sent.
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
      })
      .from(drafts)
      .innerJoin(messages, eq(messages.id, drafts.messageId))
      .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
      .innerJoin(mailboxes, eq(mailboxes.id, tickets.mailboxId))
      .innerJoin(customers, eq(customers.id, tickets.customerId))
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
    const raw = await buildReply({
      from: row.mailbox,
      to: row.customer,
      subject,
      text: draft.body,
      messageId: draft.outboundMessageIdHeader,
      inReplyTo: inbound.messageIdHeader,
      references,
      date: now,
    });

    // Database writes first and the send last: if the send fails, the transaction rolls back,
    // the draft stays `approved` and pg-boss retries.
    const rawFileKey = `${tenantId}/${uuidv7()}`;
    await deps.files.put(rawFileKey, raw);
    const sentMessageId = uuidv7();
    await tx.insert(messages).values({
      id: sentMessageId,
      tenantId,
      ticketId: draft.ticketId,
      direction: "outbound",
      fromAddress: row.mailbox,
      toAddresses: [row.customer],
      subject,
      textBody: draft.body,
      messageIdHeader: draft.outboundMessageIdHeader,
      inReplyTo: inbound.messageIdHeader,
      references,
      rawFileKey,
      sentAt: now,
    });
    const updated = await tx
      .update(drafts)
      .set({ status: "sent", sentAt: now, sentMessageId })
      .where(and(eq(drafts.id, draftId), eq(drafts.status, "approved")))
      .returning({ id: drafts.id });
    if (updated.length === 0) throw new Error("send-reply: draft changed while sending");
    await tx.update(tickets).set({ lastMessageAt: now }).where(eq(tickets.id, draft.ticketId));
    await recordAudit(tx, {
      tenantId,
      actor: sendWorkerActor,
      action: "draft.sent",
      target: { type: "draft", id: draftId },
      requestId: null,
    });

    await deps.transport.send({ from: row.mailbox, to: [row.customer], raw });
    deps.logger.info({ draftId, ticketId: draft.ticketId }, "reply sent");
  };
}
