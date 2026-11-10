import { and, eq, inArray, isNull, lt, lte, or, schema, sql, type TenantTx } from "@helpos/db";
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
  noticeDelaySeconds: number;
  /**
   * GitHub's time for this change (the issue's `updated_at`). A link last changed by a newer
   * event is left alone: GitHub can deliver a close late (a retry, a redelivery) after the
   * issue was reopened, and that must not tell the customer it's fixed.
   */
  changedAt: Date | null;
  /**
   * Read from GitHub just now, so it is the issue's state, not one event of several: it applies
   * on an equal time too. A webhook event with the same time as the last change can't be
   * ordered (GitHub's times are to the second), so it changes nothing: see tiedLinks().
   */
  current?: boolean;
}

function linksTo(change: IssueChange, state: "open" | "closed") {
  const after = change.current ? lte : lt;
  return and(
    eq(ticketGithubIssues.repo, change.repo),
    eq(ticketGithubIssues.issueNumber, change.number),
    eq(ticketGithubIssues.state, state),
    change.changedAt
      ? or(
          isNull(ticketGithubIssues.stateChangedAt),
          after(ticketGithubIssues.stateChangedAt, change.changedAt),
        )
      : undefined,
  );
}

/**
 * The issue's links in `state` last changed in the very second of this event: a close and a
 * reopen in one second can't be told apart by time, so which came last is unknown. The caller
 * has the worker read the issue's state from GitHub for these, instead of guessing.
 */
export async function tiedLinks(
  tx: TenantTx,
  change: IssueChange,
  state: "open" | "closed",
): Promise<string[]> {
  if (!change.changedAt) return [];
  const rows = await tx
    .select({ id: ticketGithubIssues.id })
    .from(ticketGithubIssues)
    .where(
      and(
        eq(ticketGithubIssues.repo, change.repo),
        eq(ticketGithubIssues.issueNumber, change.number),
        eq(ticketGithubIssues.state, state),
        eq(ticketGithubIssues.stateChangedAt, change.changedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** A change with no time of its own keeps the time of the last one. */
const changedAt = (change: IssueChange) =>
  change.changedAt ? { stateChangedAt: change.changedAt } : {};

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
    .set({ state: "closed", closedAt: sql`now()`, ...changedAt(change) })
    .where(linksTo(change, "open"))
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
    .set({ state: "open", closedAt: null, ...changedAt(change) })
    .where(linksTo(change, "closed"))
    .returning({ ticketId: ticketGithubIssues.ticketId });
  // A reopen with no closed link to change (its close not delivered yet) still records its
  // time on the open links, so that close, arriving late, is seen as older and ignored.
  if (change.changedAt) {
    await tx
      .update(ticketGithubIssues)
      .set({ stateChangedAt: change.changedAt })
      .where(
        and(
          eq(ticketGithubIssues.repo, change.repo),
          eq(ticketGithubIssues.issueNumber, change.number),
          eq(ticketGithubIssues.state, "open"),
          or(
            isNull(ticketGithubIssues.stateChangedAt),
            lt(ticketGithubIssues.stateChangedAt, change.changedAt),
          ),
        ),
      );
  }
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
