import { and, eq, inArray, schema, sql, type TenantTx } from "@helpos/db";
import { type AuditActor, recordAudit } from "../audit/audit.ts";
import { addFixedDraft } from "./fixed-notice.ts";

const { drafts, ticketGithubIssues } = schema;

/**
 * What happens to linked tickets when GitHub says an issue closed or reopened. One place, used
 * by the webhook and by issue creation (an issue can close before its link is written), so both
 * paths follow the same rules.
 */
export interface IssueChange {
  tenantId: string;
  /** Lowercase `owner/name`. */
  repo: string;
  number: number;
  actor: AuditActor;
  requestId: string | null;
  noticeDelaySeconds?: number | undefined;
}

function linksTo(repo: string, number: number, state: "open" | "closed") {
  return and(
    eq(ticketGithubIssues.repo, repo),
    eq(ticketGithubIssues.issueNumber, number),
    eq(ticketGithubIssues.state, state),
  );
}

/**
 * Marks the issue's open links closed. Closed as completed (or with no reason, as old
 * deliveries have), each ticket gets a "fixed" draft; "not planned" or "duplicate" isn't a fix,
 * so the customer is told nothing. Conditional on `open`, so a repeat or replay changes nothing.
 * Returns how many tickets changed.
 */
export async function markIssueClosed(
  tx: TenantTx,
  change: IssueChange & { stateReason: string | null | undefined },
): Promise<number> {
  const closed = await tx
    .update(ticketGithubIssues)
    .set({ state: "closed", closedAt: sql`now()` })
    .where(linksTo(change.repo, change.number, "open"))
    .returning({ ticketId: ticketGithubIssues.ticketId });
  const fixed = (change.stateReason ?? "completed") === "completed";
  for (const { ticketId } of closed) {
    await recordAudit(tx, {
      tenantId: change.tenantId,
      actor: change.actor,
      action: "github_issue.closed",
      target: { type: "ticket", id: ticketId },
      requestId: change.requestId,
    });
    if (fixed) {
      await addFixedDraft(tx, {
        tenantId: change.tenantId,
        ticketId,
        actor: change.actor,
        requestId: change.requestId,
        noticeDelaySeconds: change.noticeDelaySeconds,
      });
    }
  }
  return closed.length;
}

/**
 * Marks the issue's closed links open again. A "fixed" notice still waiting for approval is
 * withdrawn (discarded): the fix didn't hold, and nobody should approve "it's fixed" while the
 * issue is open. One already approved or sent can't be called back. If the issue closes again,
 * a fresh notice is drafted then. Returns how many tickets changed.
 */
export async function markIssueReopened(tx: TenantTx, change: IssueChange): Promise<number> {
  const reopened = await tx
    .update(ticketGithubIssues)
    .set({ state: "open", closedAt: null })
    .where(linksTo(change.repo, change.number, "closed"))
    .returning({ ticketId: ticketGithubIssues.ticketId });
  if (reopened.length === 0) return 0;
  const tickets = reopened.map((r) => r.ticketId);
  const withdrawn = await tx
    .update(drafts)
    .set({ status: "discarded" })
    .where(
      and(
        inArray(drafts.ticketId, tickets),
        eq(drafts.kind, "fixed"),
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id });
  for (const { ticketId } of reopened) {
    await recordAudit(tx, {
      tenantId: change.tenantId,
      actor: change.actor,
      action: "github_issue.reopened",
      target: { type: "ticket", id: ticketId },
      requestId: change.requestId,
    });
  }
  for (const { id } of withdrawn) {
    await recordAudit(tx, {
      tenantId: change.tenantId,
      actor: change.actor,
      action: "draft.discarded",
      target: { type: "draft", id },
      requestId: change.requestId,
    });
  }
  return reopened.length;
}
