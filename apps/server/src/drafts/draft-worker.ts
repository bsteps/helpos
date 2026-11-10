import {
  draftReply,
  type LanguageModel,
  maxHistoryMessages,
  maxKnowledgeArticles,
} from "@helpos/ai";
import { and, desc, eq, lt, ne, schema, type TenantTransaction, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import {
  dailyBudget,
  lockUsage,
  recordUsage,
  totalTokens,
  usageOn,
  utcDay,
} from "../ai-budget/budget.ts";
import { auditorFor, recordAudit } from "../audit/audit.ts";
import {
  noKnowledge,
  SearchError,
  type SearchProvider,
  type SearchQuery,
  type SearchResult,
} from "../knowledge/search.ts";
import type { Clock, ServerConfig } from "../services.ts";
import { messageText } from "./html-text.ts";
import { createReply, liveDraftFor, lockTicketForDrafting } from "./lifecycle.ts";

const { draftCitations, messages, tickets } = schema;

/** Passages retrieved per draft. More cost tokens and dilute the answer. */
export const knowledgeLimit = Math.min(5, maxKnowledgeArticles);
/** The retrieval query is the email's start: subject and opening lines say what it's about. */
const maxQueryChars = 2_000;

/**
 * What the email asks, to search the knowledge base with: the subject and the new text only.
 * Quoted earlier messages ("> …", "On … wrote:") and the signature are left out: in a short
 * follow-up they would be most of the query and match the old question instead of the new one.
 */
const quoteHeader = /^on\b.{0,300}\bwrote:$/i;
const namesSenderOrDate = /@|\b(19|20)\d\d\b/;

export function retrievalQuery(subject: string, body: string): string {
  const lines: string[] = [];
  const all = body.split("\n");
  for (const [i, line] of all.entries()) {
    const bare = line.trim();
    // The start of the quoted thread ("On … wrote:", which mail clients often wrap onto a
    // second line), or of the signature ("-- " by convention).
    const header = `${bare} ${all[i + 1]?.trim() ?? ""}`.trim();
    // A real header names a sender (an address) or a date (a year), so a customer's own
    // "On my invoice … as you wrote:" isn't one.
    const isQuoteHeader = (s: string) => quoteHeader.test(s) && namesSenderOrDate.test(s);
    if (isQuoteHeader(bare) || isQuoteHeader(header)) break;
    if (/^-{2,}\s*original message/i.test(bare) || line.trimEnd() === "--") break;
    if (bare.startsWith(">")) continue;
    lines.push(line);
  }
  const text = lines.join("\n").trim();
  const topic = subject.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim();
  return `${topic}\n\n${text || body}`.slice(0, maxQueryChars);
}

export interface DraftWorkerDeps {
  model: LanguageModel;
  logger: Pick<Logger, "info" | "warn">;
  /** The budget day is read from it. */
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget" | "noticeDelaySeconds">;
  /** The workspace's knowledge. Without it, drafts are written from the email alone. */
  search?: SearchProvider | undefined;
}

export const draftWorkerActor = { type: "system", id: "draft-reply" } as const;

/**
 * The workspace's best-matching knowledge, or none when search fails (embedding provider down,
 * wrong key). Drafting worked without knowledge before, so a broken search must not stop it.
 * Only this workspace's knowledge: it runs in the job's withTenant() transaction, inside a
 * savepoint, so a failed query can't break the rest of the job.
 */
async function searchOrNothing(
  deps: DraftWorkerDeps,
  tx: TenantTx,
  query: SearchQuery,
): Promise<SearchResult> {
  const { search } = deps;
  if (!search) return noKnowledge;
  try {
    return await tx.transaction((sp) => search.search(sp, query));
  } catch (error) {
    deps.logger.warn({ err: error }, "knowledge search failed: drafting without it");
    // Its embedding call may have been paid for before the failure.
    return { ...noKnowledge, tokens: error instanceof SearchError ? error.tokens : 0 };
  }
}

type Spent = { inputTokens: number; outputTokens: number };

/**
 * Runs once every attempt to draft has failed (the model kept erroring, say). The ticket is
 * marked `draft_failed`, so the dashboard offers to ask the AI again or write the reply,
 * instead of waiting for a draft that will never come. Left alone when the message got a
 * draft meanwhile, or when the customer wrote again (that message's own job drafts for it).
 */
export async function handleDraftGaveUp(
  payload: { tenantId: string; messageId: string },
  tx: TenantTx,
): Promise<void> {
  const [row] = await tx
    .select({ ticketId: messages.ticketId })
    .from(messages)
    .where(eq(messages.id, payload.messageId));
  if (!row) return;
  // Locked, as every drafting path does, so a person's draft that arrives meanwhile can't end
  // up next to `draft_failed`.
  const lock = await lockTicketForDrafting(tx, row.ticketId);
  // The customer wrote again: that message's own job drafts for it.
  if (lock?.answering !== payload.messageId) return;
  if (await liveDraftFor(tx, payload.messageId, "reply")) return;
  await tx
    .update(tickets)
    .set({ aiPausedReason: "draft_failed" })
    .where(eq(tickets.id, row.ticketId));
  await recordAudit(tx, {
    tenantId: payload.tenantId,
    actor: draftWorkerActor,
    action: "ai.draft_failed",
    target: { type: "ticket", id: row.ticketId },
    requestId: null,
  });
}

/**
 * Drafts a reply to one inbound message and saves it as `pending`. It never sends anything:
 * a person or an agent with `drafts:approve` has to approve it first.
 *
 * One transaction, which holds the budget lock across the model call so the cap can't be raced.
 * If it fails after a paid call (the model is down after the search embedded the email, or a
 * write fails), it rolls back with the spend in it. That spend is then recorded on its own,
 * so retries can't run past the cap uncounted.
 */
export function handleDraftReply(deps: DraftWorkerDeps) {
  const run = draftInTransaction(deps);
  return async (
    payload: { tenantId: string; messageId: string },
    transaction: TenantTransaction,
  ): Promise<void> => {
    const day = utcDay(deps.clock.now());
    const spent: Spent = { inputTokens: 0, outputTokens: 0 };
    try {
      await transaction((tx) => run(payload, tx, day, spent));
    } catch (error) {
      if (spent.inputTokens + spent.outputTokens > 0) {
        try {
          await transaction((tx) => recordUsage(tx, payload.tenantId, day, spent));
        } catch (recordError) {
          deps.logger.warn(
            { err: recordError, ...spent },
            "draft-reply: could not record the spend of a failed attempt",
          );
        }
      }
      throw error;
    }
  };
}

function draftInTransaction(deps: DraftWorkerDeps) {
  return async (
    payload: { tenantId: string; messageId: string },
    tx: TenantTx,
    day: string,
    spent: Spent,
  ): Promise<void> => {
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

    // A retry after the draft was saved, or already answered.
    if (await liveDraftFor(tx, payload.messageId, "reply")) return;

    // The hard cap. Over budget, the ticket is marked and the job ends without a draft. The
    // budget resets with the UTC day.
    const pause = async (usedTokens: number) => {
      // The search may have embedded the email before the lock showed the cap was reached.
      if (totalTokens(spent) > 0) await recordUsage(tx, payload.tenantId, day, spent);
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
      deps.logger.warn({ ticketId: row.ticketId, usedTokens }, "AI paused: daily budget reached");
    };
    // Read first, without the lock, so nothing is paid for over the cap, and the email's
    // embedding below doesn't hold up the workspace's other drafts.
    const budget = await dailyBudget(tx, payload.tenantId, deps.config.dailyTokenBudget);
    const before = totalTokens(await usageOn(tx, day));
    if (before >= budget) return pause(before);

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

    const emailBody = messageText(row);
    const knowledge = await searchOrNothing(deps, tx, {
      tenantId: payload.tenantId,
      text: retrievalQuery(row.subject, emailBody),
      limit: knowledgeLimit,
    });
    spent.inputTokens += knowledge.tokens;
    // The model sees at most this many, and citations are matched to them by position.
    const hits = knowledge.hits.slice(0, maxKnowledgeArticles);

    // Now locked, and held across the model call, so two drafts can't both pass the cap.
    const used = totalTokens(await lockUsage(tx, payload.tenantId, day));
    if (used >= budget) return pause(used);
    // Another job for this message (a retry overlapping a slow attempt) may have drafted it
    // while this one searched and waited for the lock. Looked at again before paying the model.
    const drafted = await liveDraftFor(tx, payload.messageId, "reply");
    if (drafted) {
      if (totalTokens(spent) > 0) await recordUsage(tx, payload.tenantId, day, spent);
      return;
    }

    const result = await draftReply(deps.model, {
      from: row.fromAddress,
      subject: row.subject,
      body: emailBody,
      history: earlier
        .reverse()
        .filter((m) => m.automatedReason === null)
        .map((m) => ({ direction: m.direction, from: m.from, body: messageText(m) })),
      // Internal notes are used too: a human approves every draft before it's sent.
      knowledge: hits.map((h) => ({
        title: h.title,
        url: h.url,
        content: h.content,
        internal: h.visibility === "internal",
      })),
    });
    spent.inputTokens += result.usage.inputTokens;
    spent.outputTokens += result.usage.outputTokens;
    // Recorded right away, in this transaction. If a later step fails, the handler records it
    // again after the rollback.
    await recordUsage(tx, payload.tenantId, day, spent);
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
    const lock = await lockTicketForDrafting(tx, row.ticketId);
    // The customer wrote again: that message's own job drafts the answer.
    if (lock?.answering !== payload.messageId) return;
    if (await liveDraftFor(tx, payload.messageId, "reply")) return;

    // This is the latest message, so createReply discards pending replies to earlier ones.
    const draft = await createReply(tx, auditorFor(payload.tenantId, draftWorkerActor), {
      tenantId: payload.tenantId,
      ticketId: row.ticketId,
      messageId: payload.messageId,
      body,
      noticeDelaySeconds: deps.config.noticeDelaySeconds,
    });
    // Every passage the model saw, so the approver can check the draft against its sources.
    if (hits.length > 0) {
      await tx.insert(draftCitations).values(
        hits.map((hit, rank) => ({
          tenantId: payload.tenantId,
          draftId: draft.id,
          sourceId: hit.sourceId,
          title: hit.title,
          url: hit.url,
          visibility: hit.visibility,
          excerpt: hit.content,
          rank,
          cited: result.cited.includes(rank),
        })),
      );
    }
    deps.logger.info({ draftId: draft.id, ticketId: row.ticketId }, "draft created");
  };
}
