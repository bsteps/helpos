import {
  draftGithubIssue,
  failedDraftCost,
  issueDraftTokenEstimate,
  type LanguageModel,
} from "@helpos/ai";
import { and, asc, type Database, eq, isNull, schema } from "@helpos/db";
import type { Logger } from "pino";
import { dailyBudget, reserveUsage, settleUsage, utcDay } from "../ai-budget/budget.ts";
import { messageText } from "../drafts/html-text.ts";
import type { Auditor } from "../http/route-kit.ts";
import type { Clock, ServerConfig } from "../services.ts";

const { messages, tickets } = schema;

export interface DraftIssueDeps {
  db: Pick<Database, "withTenant">;
  logger: Pick<Logger, "warn">;
  model: LanguageModel;
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget">;
}

export type DraftIssueOutcome =
  | { kind: "drafted"; title: string; body: string }
  | { kind: "not_found" }
  | { kind: "refused"; error: "nothing_to_report" | "daily_budget_reached" }
  | { kind: "ai_unavailable" };

/**
 * Asks the AI for a GitHub issue's title and body from a ticket. Three steps, so no lock or
 * transaction is held while the model writes (it never holds up reply drafting): read the
 * ticket and reserve the call's cost from today's budget, call the model, settle the cost.
 */
export async function draftIssue(
  deps: DraftIssueDeps,
  input: { tenantId: string; ticketId: string; audit: Auditor },
): Promise<DraftIssueOutcome> {
  const { tenantId } = input;
  const day = utcDay(deps.clock.now());
  const prepared = await readAndReserve(deps, input, day);
  if (prepared === "not_found") return { kind: "not_found" };
  if (typeof prepared === "string") return { kind: "refused", error: prepared };

  let draft: Awaited<ReturnType<typeof draftGithubIssue>>;
  try {
    draft = await draftGithubIssue(deps.model, prepared.input);
  } catch (error) {
    deps.logger.warn({ err: error }, "github issue draft: AI call failed");
    await settleFailedCall(deps, tenantId, day, prepared.reserved, failedDraftCost(error));
    return { kind: "ai_unavailable" };
  }

  // Swap the reservation for the real cost. If that fails, the draft is still returned: it is
  // paid for, and the reservation (an upper bound) stays counted, so the budget may overcount,
  // never undercount.
  try {
    await deps.db.withTenant(tenantId, (tx) =>
      settleUsage(tx, day, prepared.reserved, draft.usage),
    );
  } catch (error) {
    deps.logger.warn({ err: error }, "github issue draft: usage not settled");
  }
  return { kind: "drafted", title: draft.title, body: draft.body };
}

/** Step 1: the ticket's text for the model, and the call's cost reserved, in one statement. */
async function readAndReserve(
  deps: DraftIssueDeps,
  input: { tenantId: string; ticketId: string; audit: Auditor },
  day: string,
) {
  const { tenantId, ticketId } = input;
  // One statement for the reservation: concurrent calls can't all pass the cap.
  return deps.db.withTenant(tenantId, async (tx) => {
    const [ticket] = await tx
      .select({ subject: tickets.subject })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!ticket) return "not_found" as const;
    const rows = await tx
      .select({
        direction: messages.direction,
        from: messages.fromAddress,
        textBody: messages.textBody,
        htmlBody: messages.htmlBody,
      })
      .from(messages)
      // Machine mail (bounces, out-of-office) says nothing about the bug.
      .where(and(eq(messages.ticketId, ticketId), isNull(messages.automatedReason)))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    const lastInbound = rows.findLastIndex((m) => m.direction === "inbound");
    const latest = rows[lastInbound];
    if (!latest) return "nothing_to_report" as const;
    const modelInput = {
      from: latest.from,
      subject: ticket.subject,
      body: messageText(latest),
      history: rows.slice(0, lastInbound).map((m) => ({
        direction: m.direction,
        from: m.from,
        body: messageText(m),
      })),
    };
    const reserved = issueDraftTokenEstimate(modelInput);
    const budget = await dailyBudget(tx, tenantId, deps.config.dailyTokenBudget);
    if (!(await reserveUsage(tx, tenantId, day, reserved, budget))) {
      return "daily_budget_reached" as const;
    }
    // Logged with the reservation, in its transaction: from here on the call is paid for.
    await input.audit(tx, "github_issue.drafted", { type: "ticket", id: ticketId });
    return { input: modelInput, reserved };
  });
}

/**
 * Counts what a failed call cost: what the model reported when it answered, nothing when the
 * provider plainly refused, and when that can't be told, the reservation stays.
 */
async function settleFailedCall(
  deps: DraftIssueDeps,
  tenantId: string,
  day: string,
  reserved: number,
  cost: ReturnType<typeof failedDraftCost>,
): Promise<void> {
  if (cost === "unknown") return;
  try {
    await deps.db.withTenant(tenantId, (tx) =>
      settleUsage(tx, day, reserved, cost === "none" ? null : cost),
    );
  } catch (settleError) {
    // The reservation stays counted, so the budget may overcount, never undercount.
    deps.logger.warn({ err: settleError }, "github issue draft: usage not settled");
  }
}
