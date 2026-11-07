import { draftReply, type LanguageModel } from "@helpos/ai";
import { eq, schema, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.ts";

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
      .where(eq(drafts.messageId, payload.messageId));
    if (existing) return; // a retry after the draft was saved

    const result = await draftReply(deps.model, {
      from: row.fromAddress,
      subject: row.subject,
      body: row.textBody ?? "",
    });
    const body = result.text.trim();
    // Thrown, not saved: pg-boss retries, and nobody is asked to approve an empty reply.
    if (body === "") throw new Error("draft-reply: the model returned an empty draft");

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
