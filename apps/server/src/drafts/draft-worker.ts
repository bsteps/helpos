import { draftReply, type LanguageModel, maxHistoryMessages } from "@helpos/ai";
import { and, desc, eq, lt, ne, schema, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.ts";
import { messageText } from "./html-text.ts";

const { drafts, messages, tickets } = schema;

export interface DraftWorkerDeps {
  model: LanguageModel;
  logger: Pick<Logger, "info" | "warn">;
}

export const draftWorkerActor = { type: "system", id: "draft-reply" } as const;

/**
 * Drafts a reply to one inbound message and saves it as `pending`. It never sends anything:
 * a person or an agent with `drafts:approve` has to approve it first.
 */
export function handleDraftReply(deps: DraftWorkerDeps) {
  return async (payload: { tenantId: string; messageId: string }, tx: TenantTx): Promise<void> => {
    const [row] = await tx
      .select({
        ticketId: messages.ticketId,
        direction: messages.direction,
        fromAddress: messages.fromAddress,
        subject: messages.subject,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
        createdAt: messages.createdAt,
        automatedReason: messages.automatedReason,
        ticketAutomated: tickets.automated,
      })
      .from(messages)
      .innerJoin(tickets, eq(tickets.id, messages.ticketId))
      .where(eq(messages.id, payload.messageId));
    if (!row) {
      deps.logger.warn({ messageId: payload.messageId }, "draft-reply: message not found");
      return;
    }
    // Ingest already skips these; checked again so a stray job can't draft for a machine.
    if (row.direction !== "inbound" || row.automatedReason !== null || row.ticketAutomated) return;

    const [existing] = await tx
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.messageId, payload.messageId), ne(drafts.status, "discarded")));
    if (existing) return; // a retry after the draft was saved, or already answered

    // The conversation before this message, so a follow-up is answered in context. Machine
    // mail on the ticket is left out: it's noise, and never something to answer.
    const earlier = await tx
      .select({
        direction: messages.direction,
        from: messages.fromAddress,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
        automatedReason: messages.automatedReason,
      })
      .from(messages)
      .where(
        and(
          eq(messages.ticketId, row.ticketId),
          ne(messages.id, payload.messageId),
          lt(messages.createdAt, row.createdAt),
        ),
      )
      // Newest first, so the limit keeps the most recent; reversed below to oldest first.
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(maxHistoryMessages);

    const result = await draftReply(deps.model, {
      from: row.fromAddress,
      subject: row.subject,
      body: messageText(row),
      history: earlier
        .reverse()
        .filter((m) => m.automatedReason === null)
        .map((m) => ({ direction: m.direction, from: m.from, body: messageText(m) })),
    });
    const body = result.text.trim();
    // Thrown, not saved: pg-boss retries, and nobody is asked to approve an empty reply.
    if (body === "") throw new Error("draft-reply: the model returned an empty draft");

    // A newer message makes older pending drafts stale. Discard them, so nobody approves an
    // answer to a question the customer has moved past. Approved ones are already on their way.
    const stale = await tx
      .update(drafts)
      .set({ status: "discarded" })
      .where(and(eq(drafts.ticketId, row.ticketId), eq(drafts.status, "pending")))
      .returning({ id: drafts.id });
    for (const { id } of stale) {
      await recordAudit(tx, {
        tenantId: payload.tenantId,
        actor: draftWorkerActor,
        action: "draft.discarded",
        target: { type: "draft", id },
        requestId: null,
      });
    }

    const [draft] = await tx
      .insert(drafts)
      .values({
        tenantId: payload.tenantId,
        ticketId: row.ticketId,
        messageId: payload.messageId,
        body,
      })
      .returning({ id: drafts.id });
    if (!draft) throw new Error("draft-reply: insert returned no row");

    await recordAudit(tx, {
      tenantId: payload.tenantId,
      actor: draftWorkerActor,
      action: "draft.created",
      target: { type: "draft", id: draft.id },
      requestId: null,
    });
    deps.logger.info({ draftId: draft.id, ticketId: row.ticketId }, "draft created");
  };
}
