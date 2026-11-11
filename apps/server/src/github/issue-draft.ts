import {
  draftGithubIssue,
  failedDraftCost,
  issueDraftTokenEstimate,
  type LanguageModel,
} from "@helpos/ai";
import { and, asc, type Database, eq, isNull, schema, tenantTransactions } from "@helpos/db";
import type { Logger } from "pino";
import { aiBudget } from "../ai-budget/budget.ts";
import type { Auditor } from "../audit/audit.ts";
import { messageText } from "../drafts/html-text.ts";
import type { Clock, ServerConfig } from "../services.ts";

const { messages, conversations } = schema;

export interface DraftIssueDeps {
  db: Pick<Database, "withTenant">;
  logger: Pick<Logger, "warn">;
  model: LanguageModel;
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget">;
  shutdown?: AbortSignal | undefined;
}

export type DraftIssueOutcome =
  | { kind: "drafted"; title: string; body: string }
  | { kind: "not_found" }
  | { kind: "refused"; error: "nothing_to_report" | "daily_budget_reached" }
  | { kind: "ai_busy" }
  | { kind: "ai_unavailable" };

/**
 * Asks the AI for a GitHub issue's title and body from a conversation. Read the conversation and reserve
 * the call's cost from today's budget, then make the call with no transaction open (it never
 * holds up reply drafting), and settle the cost.
 */
export async function draftIssue(
  deps: DraftIssueDeps,
  input: { tenantId: string; conversationId: string; audit: Auditor },
): Promise<DraftIssueOutcome> {
  const budget = aiBudget(deps);
  const prepared = await readAndReserve(deps, budget, input);
  if (prepared === "not_found") return { kind: "not_found" };
  if (prepared === "busy") return { kind: "ai_busy" };
  if (prepared === "over_budget") return { kind: "refused", error: "daily_budget_reached" };
  if (prepared === "nothing_to_report") return { kind: "refused", error: prepared };

  try {
    const draft = await budget.spend(
      tenantTransactions(deps.db, input.tenantId),
      prepared.reservation,
      (signal) => draftGithubIssue(deps.model, prepared.input, { abortSignal: signal }),
      { of: (d) => d.usage, ofFailure: failedDraftCost },
    );
    return { kind: "drafted", title: draft.title, body: draft.body };
  } catch (error) {
    deps.logger.warn({ err: error }, "github issue draft: AI call failed");
    return { kind: "ai_unavailable" };
  }
}

/** The conversation's text for the model, and the call's cost reserved. */
async function readAndReserve(
  deps: DraftIssueDeps,
  budget: ReturnType<typeof aiBudget>,
  input: { tenantId: string; conversationId: string; audit: Auditor },
) {
  const { tenantId, conversationId } = input;
  return deps.db.withTenant(tenantId, async (tx) => {
    const [conversation] = await tx
      .select({ subject: conversations.subject })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conversation) return "not_found" as const;
    const rows = await tx
      .select({
        direction: messages.direction,
        from: messages.fromAddress,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
      })
      .from(messages)
      // Machine mail (bounces, out-of-office) says nothing about the bug.
      .where(and(eq(messages.conversationId, conversationId), isNull(messages.automatedReason)))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const lastInbound = rows.findLastIndex((m) => m.direction === "inbound");
    const latest = rows[lastInbound];
    if (!latest) return "nothing_to_report" as const;
    const modelInput = {
      from: latest.from,
      subject: conversation.subject,
      body: messageText(latest),
      history: rows.slice(0, lastInbound).map((m) => ({
        direction: m.direction,
        from: m.from,
        body: messageText(m),
      })),
    };
    const reservation = await budget.reserve(tx, tenantId, issueDraftTokenEstimate(modelInput));
    if (reservation === "busy") return reservation;
    if ("refused" in reservation) return reservation.refused;
    // Logged with the reservation, in its transaction: from here on the call is paid for.
    await input.audit(tx, "github_issue.drafted", { type: "conversation", id: conversationId });
    return { input: modelInput, reservation };
  });
}
