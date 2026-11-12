import {
  and,
  enqueue,
  eq,
  inArray,
  schema,
  type TenantStepsHandler,
  type TenantTx,
} from "@helpos/db";
import { builtInActors } from "@helpos/db/actor";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.ts";
import type { SecretBox } from "../secrets/secret-box.ts";
import type { ServerConfig } from "../services.ts";
import { type GithubApiFactory, parseRepo } from "./github-api.ts";
import { openGithubAccess } from "./integration.ts";
import { markIssueClosed, markIssueReopened } from "./issue-state.ts";
import { recheckIssueJob } from "./jobs.ts";

const { conversationGithubIssues } = schema;

/** Checks stop a day after the link's last change: the issue's later webhooks still arrive. */
const recheckForMs = 24 * 60 * 60 * 1000;

/** When the next check runs: `issueRecheckSeconds` from now. */
const recheckAfter = (seconds: number) => new Date(Date.now() + seconds * 1000);

/**
 * Queues a read of the link's issue from GitHub, `issueRecheckSeconds` from now. The one
 * spelling of that call, for the create flow, the webhook and the job itself. `singletonKey`:
 * at most one waiting check under that key.
 */
export async function enqueueRecheck(
  tx: TenantTx,
  payload: { tenantId: string; linkId: string },
  config: Pick<ServerConfig, "issueRecheckSeconds">,
  options: { singletonKey?: string } = {},
): Promise<void> {
  await enqueue(tx, recheckIssueJob, payload, {
    startAfter: recheckAfter(config.issueRecheckSeconds),
    ...options,
  });
}

export interface RecheckDeps {
  secretBox: SecretBox;
  github: GithubApiFactory;
  logger: Pick<Logger, "warn" | "info">;
  config: Pick<ServerConfig, "noticeDelaySeconds" | "issueRecheckSeconds">;
}

/**
 * Checks stopped without reading the issue's state: GitHub stayed unreachable for a day, or
 * the job failed every retry. The link keeps the last state it knew, and the audit event on
 * the conversation says it may be stale, so someone can look at the issue.
 */
export async function handleRecheckGaveUp(
  payload: { tenantId: string; linkId: string },
  tx: TenantTx,
): Promise<void> {
  const [link] = await tx
    .select({ conversationId: conversationGithubIssues.conversationId })
    .from(conversationGithubIssues)
    .where(eq(conversationGithubIssues.id, payload.linkId));
  if (!link) return;
  await recordAudit(tx, {
    tenantId: payload.tenantId,
    actor: builtInActors.githubRecheck,
    action: "github_issue.recheck_failed",
    target: { type: "conversation", id: link.conversationId },
    requestId: null,
  });
}

/** Steps, not one transaction: no connection is held while GitHub answers. */
export function handleRecheckIssue(
  deps: RecheckDeps,
): TenantStepsHandler<{ tenantId: string; linkId: string }> {
  return async (payload, transaction) => {
    const { tenantId, linkId } = payload;
    const target = await transaction(async (tx) => {
      const [link] = await tx
        .select({
          repo: conversationGithubIssues.repo,
          number: conversationGithubIssues.issueNumber,
          since: conversationGithubIssues.stateChangedAt,
          createdAt: conversationGithubIssues.createdAt,
        })
        .from(conversationGithubIssues)
        .where(
          and(
            eq(conversationGithubIssues.id, linkId),
            inArray(conversationGithubIssues.state, ["open", "closed"]),
          ),
        );
      // Gone (unlinked, or never more than a claim): nothing to do.
      if (!link || link.number === null) return null;
      const since = link.since ?? link.createdAt;
      const access = await openGithubAccess(tx, deps.secretBox, tenantId);
      // No token to ask with right now (disconnected, or mid-reconnect): wait for one.
      if (access === "not_connected") return { waitFor: "a connected repo", since };
      if (access === "reconnect_required") return { waitFor: "a readable token", since };
      return { ...link, number: link.number, token: access.token, since };
    });
    if (!target) return;
    /** Asks again later, not at once (pg-boss would retry a thrown job straight away). */
    const later = async (why: string, since: Date) => {
      if (Date.now() - since.getTime() > recheckForMs) {
        deps.logger.warn({ linkId, why }, "github recheck: giving up");
        await transaction((tx) => handleRecheckGaveUp(payload, tx));
        return;
      }
      await transaction((tx) => enqueueRecheck(tx, payload, deps.config));
    };
    if ("waitFor" in target) {
      deps.logger.warn({ linkId, waitingFor: target.waitFor }, "github recheck: waiting");
      await later(`waiting for ${target.waitFor}`, target.since);
      return;
    }
    const repo = parseRepo(target.repo);
    if (!repo) return;
    const now = await deps.github(target.token).issueState(repo, target.number);
    if (!now.ok) {
      // An outage, or a refusal an admin can fix (an expired token, access to the repo taken
      // away): either way, asking again later, within the day, can still tell the customer.
      deps.logger.warn({ linkId, reason: now.reason }, "github recheck: not read");
      await later(now.reason, target.since);
      return;
    }
    // GitHub's state now, which every later event is newer than. Each mark only changes a link
    // in the other state, so a link that already agrees is left as it is.
    const change = {
      tenantId,
      repo: target.repo,
      number: target.number,
      changedAt: now.value.updatedAt,
      current: true,
      actor: builtInActors.githubRecheck,
      requestId: null,
      noticeDelaySeconds: deps.config.noticeDelaySeconds,
    };
    const changed = await transaction((tx) =>
      now.value.state === "closed"
        ? markIssueClosed(tx, { ...change, stateReason: now.value.stateReason })
        : markIssueReopened(tx, change),
    );
    if (changed > 0) {
      deps.logger.info({ linkId, state: now.value.state }, "github recheck: state applied");
    }
  };
}
