import { and, eq, isNull, lt, lte, or, schema, sql, type TenantTx } from "@helpos/db";
import type { Actor } from "@helpos/db/actor";
import { recordAudit } from "../audit/audit.ts";
import { discardStale } from "../drafts/lifecycle.ts";
import { addFixedDraft } from "./fixed-notice.ts";

const { conversationGithubIssues } = schema;

/**
 * What happens to linked conversations when GitHub says an issue closed or reopened. One place, used
 * by the webhook and by issue creation (an issue can close before its link is written), so both
 * paths follow the same rules.
 */
export interface IssueChange {
  tenantId: string;
  /** Lowercase `owner/name`. */
  repo: string;
  number: number;
  actor: Actor;
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
    eq(conversationGithubIssues.repo, change.repo),
    eq(conversationGithubIssues.issueNumber, change.number),
    eq(conversationGithubIssues.state, state),
    change.changedAt
      ? or(
          isNull(conversationGithubIssues.stateChangedAt),
          after(conversationGithubIssues.stateChangedAt, change.changedAt),
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
    .select({ id: conversationGithubIssues.id })
    .from(conversationGithubIssues)
    .where(
      and(
        eq(conversationGithubIssues.repo, change.repo),
        eq(conversationGithubIssues.issueNumber, change.number),
        eq(conversationGithubIssues.state, state),
        eq(conversationGithubIssues.stateChangedAt, change.changedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** A change with no time of its own keeps the time of the last one. */
const changedAt = (change: IssueChange) =>
  change.changedAt ? { stateChangedAt: change.changedAt } : {};

/**
 * Marks the issue's open links closed. Closed as completed (or with no reason, as old
 * deliveries have), each conversation gets a "fixed" draft; "not planned" or "duplicate" isn't a fix,
 * so the customer is told nothing. Conditional on `open`, so a repeat or replay changes nothing.
 * Returns how many conversations changed.
 */
export async function markIssueClosed(
  tx: TenantTx,
  change: IssueChange & { stateReason: string | null | undefined },
): Promise<number> {
  const closed = await tx
    .update(conversationGithubIssues)
    .set({ state: "closed", closedAt: sql`now()`, ...changedAt(change) })
    .where(linksTo(change, "open"))
    .returning({ conversationId: conversationGithubIssues.conversationId });
  const fixed = (change.stateReason ?? "completed") === "completed";
  for (const { conversationId } of closed) {
    await recordAudit(tx, {
      tenantId: change.tenantId,
      actor: change.actor,
      action: "github_issue.closed",
      target: { type: "conversation", id: conversationId },
      requestId: change.requestId,
    });
    if (fixed) {
      await addFixedDraft(tx, {
        tenantId: change.tenantId,
        conversationId,
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
 * a fresh notice is drafted then. Returns how many conversations changed.
 */
export async function markIssueReopened(tx: TenantTx, change: IssueChange): Promise<number> {
  const reopened = await tx
    .update(conversationGithubIssues)
    .set({ state: "open", closedAt: null, ...changedAt(change) })
    .where(linksTo(change, "closed"))
    .returning({ conversationId: conversationGithubIssues.conversationId });
  // A reopen with no closed link to change (its close not delivered yet) still records its
  // time on the open links, so that close, arriving late, is seen as older and ignored.
  if (change.changedAt) {
    await tx
      .update(conversationGithubIssues)
      .set({ stateChangedAt: change.changedAt })
      .where(
        and(
          eq(conversationGithubIssues.repo, change.repo),
          eq(conversationGithubIssues.issueNumber, change.number),
          eq(conversationGithubIssues.state, "open"),
          or(
            isNull(conversationGithubIssues.stateChangedAt),
            lt(conversationGithubIssues.stateChangedAt, change.changedAt),
          ),
        ),
      );
  }
  if (reopened.length === 0) return 0;
  for (const { conversationId } of reopened) {
    await recordAudit(tx, {
      tenantId: change.tenantId,
      actor: change.actor,
      action: "github_issue.reopened",
      target: { type: "conversation", id: conversationId },
      requestId: change.requestId,
    });
  }
  await discardStale(
    tx,
    { tenantId: change.tenantId, actor: change.actor, requestId: change.requestId },
    {
      conversationIds: reopened.map((r) => r.conversationId),
      kind: "fixed",
    },
  );
  return reopened.length;
}
