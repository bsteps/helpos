import { draftReply, type LanguageModel, maxHistoryMessages } from "@helpos/ai";
import { and, desc, eq, gt, isNull, lt, ne, schema, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import { lockUsage, recordUsage, totalTokens, utcDay } from "../ai-budget/budget.ts";
import { recordAudit } from "../audit/audit.ts";
import { messageText } from "./html-text.ts";

const { drafts, messages, tickets } = schema;

export interface DraftWorkerDeps {
  model: LanguageModel;
  logger: Pick<Logger, "info" | "warn">;
  /** Tokens per workspace per UTC day. At or over it, no model call is made. */
  dailyTokenBudget: number;
  /** For tests: the clock the budget day is read from. */
  now?: () => Date;
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

    // The hard cap, checked before the model is called. Over budget, the ticket is marked
    // and the job ends without a draft. The budget resets with the UTC day.
    const day = utcDay((deps.now ?? (() => new Date()))());
    const used = await lockUsage(tx, payload.tenantId, day);
    if (totalTokens(used) >= deps.dailyTokenBudget) {
      await tx
        .update(tickets)
        .set({ aiPausedReason: "daily_budget" })
        .where(eq(tickets.id, row.ticketId));
      await recordAudit(tx, {
        tenantId: payload.tenantId,
        actor: draftWorkerActor,
        action: "ai.paused",
        target: { type: "ticket", id: row.ticketId },
        requestId: null,
      });
      deps.logger.warn(
        { ticketId: row.ticketId, usedTokens: totalTokens(used), budget: deps.dailyTokenBudget },
        "AI paused: daily budget reached",
      );
      return;
    }

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
    // Recorded right away, in this transaction. An unexpected error later rolls it back with
    // the rest of the job, so that one attempt goes uncounted; the cap is still checked on retry.
    await recordUsage(tx, payload.tenantId, day, result.usage);
    const body = result.text.trim();
    if (body === "") {
      // Not thrown: a retry would spend more tokens on the same answer. A person can
      // regenerate it instead.
      deps.logger.warn(
        { ticketId: row.ticketId },
        "draft-reply: the model returned an empty draft",
      );
      return;
    }

    // The model call took a while. Lock the ticket (as the create endpoint does) and look again,
    // so a slow job never overwrites what happened meanwhile.
    await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.id, row.ticketId))
      .for("update");
    const [answered] = await tx
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.messageId, payload.messageId), ne(drafts.status, "discarded")));
    if (answered) return;
    const [newer] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.ticketId, row.ticketId),
          eq(messages.direction, "inbound"),
          isNull(messages.automatedReason),
          ne(messages.id, payload.messageId),
          // Postgres keeps microseconds and a JS Date only milliseconds, so the row itself would
          // count as "newer" without the id check above.
          gt(messages.createdAt, row.createdAt),
        ),
      )
      .limit(1);
    // The customer wrote again: that message's own job drafts the answer.
    if (newer) return;

    // This is the latest message, so pending drafts for earlier ones are stale. Discard them,
    // so nobody approves an answer to a question the customer has moved past.
    const stale = await tx
      .update(drafts)
      .set({ status: "discarded" })
      .where(
        and(
          eq(drafts.ticketId, row.ticketId),
          eq(drafts.status, "pending"),
          ne(drafts.messageId, payload.messageId),
        ),
      )
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
    await tx.update(tickets).set({ aiPausedReason: null }).where(eq(tickets.id, row.ticketId));

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
