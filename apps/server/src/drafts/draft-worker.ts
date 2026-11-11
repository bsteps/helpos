import {
  type DraftResult,
  draftReply,
  EmbedError,
  failedDraftCost,
  type LanguageModel,
  maxHistoryMessages,
  maxKnowledgeArticles,
  type PaidModels,
  replyDraftTokenEstimate,
  tokenBound,
} from "@helpos/ai";
import {
  and,
  desc,
  enqueue,
  eq,
  lt,
  ne,
  schema,
  type TenantTransaction,
  type TenantTx,
} from "@helpos/db";
import type { Logger } from "pino";
import { type AiBudget, aiBudget, mapAiRefusal, type Spent } from "../ai-budget/budget.ts";
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
import { draftReplyJob } from "./jobs.ts";
import { createReply, liveDraftFor, lockConversationForDrafting } from "./lifecycle.ts";

const { draftCitations, messages, conversations } = schema;

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
  /** Aborts the search and model calls in flight when the server shuts down. */
  shutdown?: AbortSignal | undefined;
}

export const draftWorkerActor = { type: "system", id: "draft-reply" } as const;

/**
 * The workspace's best-matching knowledge, or none when search fails (embedding provider down,
 * wrong key). Drafting worked without knowledge before, so a broken search must not stop it.
 * Database reads use separate tenant transactions, so a failed query rolls back its own read
 * and embedding never holds a connection.
 */
async function searchOrNothing(
  deps: DraftWorkerDeps,
  transaction: TenantTransaction,
  query: SearchQuery,
  signal: AbortSignal,
  models: PaidModels,
): Promise<SearchResult> {
  const { search } = deps;
  if (!search) return noKnowledge;
  try {
    return await search.search(transaction, query, models);
  } catch (error) {
    // Stopped (a shutdown, or out of time): drafting on without knowledge would be wrong too.
    if (signal.aborted) throw error;
    deps.logger.warn({ err: error }, "knowledge search failed: drafting without it");
    // Its embedding call may have been paid for before the failure.
    return {
      ...noKnowledge,
      tokens: error instanceof SearchError || error instanceof EmbedError ? error.tokens : 0,
    };
  }
}

type Payload = { tenantId: string; messageId: string };

/**
 * Runs once every attempt to draft has failed (the model kept erroring, say). The conversation is
 * marked `draft_failed`, so the dashboard offers to ask the AI again or write the reply,
 * instead of waiting for a draft that will never come. Left alone when the message got a
 * draft meanwhile, or when the customer wrote again (that message's own job drafts for it).
 */
export async function handleDraftGaveUp(payload: Payload, tx: TenantTx): Promise<void> {
  const [row] = await tx
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, payload.messageId));
  if (!row) return;
  // Locked, as every drafting path does, so a person's draft that arrives meanwhile can't end
  // up next to `draft_failed`.
  const lock = await lockConversationForDrafting(tx, row.conversationId);
  // The customer wrote again: that message's own job drafts for it.
  if (lock?.answering !== payload.messageId) return;
  if (await liveDraftFor(tx, payload.messageId, "reply")) return;
  await tx
    .update(conversations)
    .set({ aiPausedReason: "draft_failed" })
    .where(eq(conversations.id, row.conversationId));
  await recordAudit(tx, {
    tenantId: payload.tenantId,
    actor: draftWorkerActor,
    action: "ai.draft_failed",
    target: { type: "conversation", id: row.conversationId },
    requestId: null,
  });
}

/**
 * Drafts a reply to one inbound message and saves it as `pending`. It never sends anything:
 * a person or an agent with `drafts:approve` has to approve it first.
 *
 * Three steps, so no transaction or lock is held while the search embeds the email and the
 * model writes: check the message still needs a draft and reserve the cost, make the calls,
 * then save the draft. The cost is settled right after the calls, whatever happens next, so
 * a retry can't run past the cap uncounted.
 */
export function handleDraftReply(deps: DraftWorkerDeps) {
  const budget = aiBudget(deps);
  return async (payload: Payload, transaction: TenantTransaction): Promise<void> => {
    const job = await transaction((tx) => prepare(deps, budget, payload, tx));
    if (!job) return;

    // What the search cost, kept apart: if the model then fails, the search still counts.
    let searchTokens = 0;
    // The most the model call can cost, once its prompt is known. Until then, a failure whose
    // cost can't be told keeps the whole reservation (made before the passages were found).
    let callBound: number | undefined;
    const answer = await budget.spend(
      transaction,
      job.reservation,
      async (signal, models) => {
        const knowledge = await searchOrNothing(deps, transaction, job.query, signal, models);
        searchTokens = knowledge.tokens;
        const found = await transaction(async (tx) => {
          // Another job for this message (a retry overlapping a slow attempt) may have drafted
          // it meanwhile. Looked at again before paying the model.
          return { knowledge, drafted: await liveDraftFor(tx, payload.messageId, "reply") };
        });
        // The model sees at most this many, and citations are matched to them by position.
        const hits = found.knowledge.hits.slice(0, maxKnowledgeArticles);
        if (found.drafted) return { hits, result: null };
        const input = {
          ...job.input,
          // Internal notes are used too: a human approves every draft before it's sent.
          knowledge: hits.map((h) => ({
            title: h.title,
            url: h.url,
            content: h.content,
            internal: h.visibility === "internal",
          })),
        };
        callBound = replyDraftTokenEstimate(input);
        return { hits, result: await draftReply(models(deps.model), input) };
      },
      {
        of: ({ result }) => ({
          inputTokens: searchTokens + (result?.usage.inputTokens ?? 0),
          outputTokens: result?.usage.outputTokens ?? 0,
        }),
        ofFailure: (error) => {
          const model = failedDraftCost(error);
          if (model === "unknown" && callBound === undefined) return "unknown";
          const used: Spent =
            model === "unknown"
              ? { inputTokens: callBound ?? 0, outputTokens: 0 }
              : model === "none"
                ? { inputTokens: 0, outputTokens: 0 }
                : model;
          return { ...used, inputTokens: used.inputTokens + searchTokens };
        },
      },
    );
    const { result, hits } = answer;
    if (!result) return;
    const body = result.text.trim();
    if (body === "") {
      // Not thrown: a retry would spend more tokens on the same answer. A person can
      // regenerate it instead.
      deps.logger.warn(
        { conversationId: job.conversationId },
        "draft-reply: the model returned an empty draft",
      );
      return;
    }
    await transaction((tx) =>
      save(deps, payload, tx, { conversationId: job.conversationId, body, result, hits }),
    );
  };
}

/**
 * Step 1: whether the message still needs a draft, what to ask the model, and the cost
 * reserved. Over budget, the conversation is marked paused instead.
 */
async function prepare(deps: DraftWorkerDeps, budget: AiBudget, payload: Payload, tx: TenantTx) {
  const [row] = await tx
    .select({
      conversationId: messages.conversationId,
      direction: messages.direction,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      textBody: messages.textBody,
      htmlBody: messages.htmlBody,
      createdAt: messages.createdAt,
      automatedReason: messages.automatedReason,
      conversationAutomated: conversations.automated,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, payload.messageId));
  if (!row) {
    deps.logger.warn({ messageId: payload.messageId }, "draft-reply: message not found");
    return null;
  }
  // Ingest already skips these; checked again so a stray job can't draft for a machine.
  if (row.direction !== "inbound" || row.automatedReason !== null || row.conversationAutomated) {
    return null;
  }
  // Locked, as every drafting path does, so a person's draft can't land in between.
  const lock = await lockConversationForDrafting(tx, row.conversationId);
  // The customer wrote again: that message's own job drafts the answer.
  if (lock?.answering !== payload.messageId) return null;
  // Closed meanwhile (e.g. while it waited for the budget to reset): nothing to answer. A
  // customer who writes again reopens it, and their message gets a job of its own.
  if (lock.closed) return null;
  // A retry after the draft was saved, or already answered.
  if (await liveDraftFor(tx, payload.messageId, "reply")) return null;

  // The conversation before this message, so a follow-up is answered in context. Machine
  // mail on the conversation is left out: it's noise, and never something to answer.
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
        eq(messages.conversationId, row.conversationId),
        ne(messages.id, payload.messageId),
        lt(messages.createdAt, row.createdAt),
      ),
    )
    // Newest first, so the limit keeps the most recent; reversed below to oldest first.
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(maxHistoryMessages);

  const emailBody = messageText(row);
  const input = {
    from: row.fromAddress,
    subject: row.subject,
    body: emailBody,
    history: earlier
      .reverse()
      .filter((m) => m.automatedReason === null)
      .map((m) => ({ direction: m.direction, from: m.from, body: messageText(m) })),
  };
  const query = {
    tenantId: payload.tenantId,
    text: retrievalQuery(row.subject, emailBody),
    limit: knowledgeLimit,
  };
  // The search's embedding of the email, and the reply with as many passages as it may find.
  const estimate =
    (deps.search ? tokenBound(query.text) : 0) +
    replyDraftTokenEstimate(input, deps.search ? knowledgeLimit : 0);
  const reservation = await budget.reserve(tx, payload.tenantId, estimate);
  if ("refused" in reservation) {
    await mapAiRefusal(reservation, {
      busy: async (startAfter) => {
        await enqueue(tx, draftReplyJob, payload, { startAfter });
      },
      over_budget: (retryAt) => pause(deps, retryAt, payload, tx, row.conversationId),
    });
    return null;
  }
  return { conversationId: row.conversationId, input, query, reservation };
}

/**
 * The hard cap: the conversation is marked, and the job runs again when the budget resets at UTC
 * midnight (one waiting job per message per day). By then the customer may have written
 * again, or someone answered by hand: it then ends without a draft.
 */
async function pause(
  deps: DraftWorkerDeps,
  resetsAt: Date,
  payload: Payload,
  tx: TenantTx,
  conversationId: string,
): Promise<void> {
  await tx
    .update(conversations)
    .set({ aiPausedReason: "daily_budget" })
    .where(eq(conversations.id, conversationId));
  await recordAudit(tx, {
    tenantId: payload.tenantId,
    actor: draftWorkerActor,
    action: "ai.paused",
    target: { type: "conversation", id: conversationId },
    requestId: null,
  });
  await enqueue(tx, draftReplyJob, payload, {
    singletonKey: `${payload.messageId}:after:${resetsAt.toISOString()}`,
    // The queue starts it by the database's clock, the budget's day comes from this server's.
    // A minute's margin, so a server clock a little behind still sees the new day: otherwise
    // the job would pause again under its own key, and nothing would be queued.
    startAfter: new Date(resetsAt.getTime() + 60_000),
  });
  deps.logger.warn({ conversationId, resetsAt }, "AI paused: daily budget reached");
}

/** Step 3: the draft and the passages it was written from, unless things moved on meanwhile. */
async function save(
  deps: DraftWorkerDeps,
  payload: Payload,
  tx: TenantTx,
  draft: { conversationId: string; body: string; result: DraftResult; hits: SearchResult["hits"] },
): Promise<void> {
  const { conversationId, body, result, hits } = draft;
  // The model call took a while. Lock the conversation (as the create endpoint does) and look again,
  // so a slow job never overwrites what happened meanwhile.
  const lock = await lockConversationForDrafting(tx, conversationId);
  // The customer wrote again: that message's own job drafts the answer.
  if (lock?.answering !== payload.messageId) return;
  // Closed while the model wrote: a draft (and its notice) would be noise.
  if (lock.closed) return;
  if (await liveDraftFor(tx, payload.messageId, "reply")) return;

  // This is the latest message, so createReply discards pending replies to earlier ones.
  const saved = await createReply(tx, auditorFor(payload.tenantId, draftWorkerActor), {
    tenantId: payload.tenantId,
    conversationId,
    messageId: payload.messageId,
    body,
    noticeDelaySeconds: deps.config.noticeDelaySeconds,
  });
  // Every passage the model saw, so the approver can check the draft against its sources.
  if (hits.length > 0) {
    await tx.insert(draftCitations).values(
      hits.map((hit, rank) => ({
        tenantId: payload.tenantId,
        draftId: saved.id,
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
  deps.logger.info({ draftId: saved.id, conversationId }, "draft created");
}
