import {
  and,
  defineTenantJob,
  enqueue,
  eq,
  inArray,
  schema,
  type TenantStepsHandler,
} from "@helpos/db";
import type { Logger } from "pino";
import { z } from "zod";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { githubWebhookActor } from "./fixed-notice.ts";
import { type GithubApiFactory, parseRepo } from "./github-api.ts";
import { markIssueClosed, markIssueReopened } from "./issue-state.ts";

const { integrations, ticketGithubIssues } = schema;

/**
 * Reads a linked issue's state from GitHub and applies it, when events alone can't say it:
 * - right after linking, if GitHub couldn't be reached: an issue can close before its link is
 *   written, and that close's webhook had nothing to match;
 * - after a close and a reopen in the same second, which GitHub's times can't order.
 * Without it, a GitHub hiccup at the wrong moment would mean the customer is never told, or is
 * told it's fixed while the issue is open.
 */
export const recheckIssueJob = defineTenantJob("github.recheck-issue", { linkId: z.uuid() });

/** How long before a check, and between checks while GitHub can't be reached. */
export const defaultRecheckSeconds = 120;
/** Checks stop a day after the link's last change: the issue's later webhooks still arrive. */
const recheckForMs = 24 * 60 * 60 * 1000;

export const recheckAfter = (seconds: number | undefined) =>
  new Date(Date.now() + (seconds ?? defaultRecheckSeconds) * 1000);

export interface RecheckDeps {
  secretBox: SecretBox;
  github: GithubApiFactory;
  logger: Pick<Logger, "warn" | "info">;
  noticeDelaySeconds?: number | undefined;
  recheckSeconds?: number | undefined;
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
          repo: ticketGithubIssues.repo,
          number: ticketGithubIssues.issueNumber,
          since: ticketGithubIssues.stateChangedAt,
          createdAt: ticketGithubIssues.createdAt,
        })
        .from(ticketGithubIssues)
        .where(
          and(
            eq(ticketGithubIssues.id, linkId),
            inArray(ticketGithubIssues.state, ["open", "closed"]),
          ),
        );
      // Gone (unlinked, or never more than a claim): nothing to do.
      if (!link || link.number === null) return null;
      const since = link.since ?? link.createdAt;
      const [integration] = await tx
        .select({ tokenCiphertext: integrations.tokenCiphertext })
        .from(integrations)
        .where(eq(integrations.provider, "github"));
      // No token to ask with right now (disconnected, or mid-reconnect): wait for one.
      if (!integration) return { waitFor: "a connected repo", since };
      try {
        const token = deps.secretBox.open(integration.tokenCiphertext, {
          tenantId,
          purpose: "github-token",
        });
        return { ...link, number: link.number, token, since };
      } catch (error) {
        if (!(error instanceof SecretBoxError)) throw error;
        return { waitFor: "a readable token", since };
      }
    });
    if (!target) return;
    /** Asks again later, not at once (pg-boss would retry a thrown job straight away). */
    const later = async (why: string, since: Date) => {
      if (Date.now() - since.getTime() > recheckForMs) {
        deps.logger.warn({ linkId, why }, "github recheck: giving up");
        return;
      }
      await transaction((tx) =>
        enqueue(tx, recheckIssueJob, payload, { startAfter: recheckAfter(deps.recheckSeconds) }),
      );
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
      // GitHub said no (the issue or repo is gone, the token lost access): asking again won't
      // change that. Only an outage, a timeout or a rate limit is worth waiting out.
      if (now.reason !== "github_unavailable") {
        deps.logger.warn({ linkId, reason: now.reason }, "github recheck: GitHub refused");
        return;
      }
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
      actor: githubWebhookActor,
      requestId: null,
      noticeDelaySeconds: deps.noticeDelaySeconds,
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
