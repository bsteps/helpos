import { and, defineTenantJob, enqueue, eq, schema, type TenantStepsHandler } from "@helpos/db";
import type { Logger } from "pino";
import { z } from "zod";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { githubWebhookActor } from "./fixed-notice.ts";
import { type GithubApiFactory, parseRepo } from "./github-api.ts";
import { markIssueClosed } from "./issue-state.ts";

const { integrations, ticketGithubIssues } = schema;

/**
 * Reads a linked issue's state again, when that couldn't be done right after linking. An issue
 * can close before its link is written, and that close's webhook had nothing to match: without
 * this, a GitHub hiccup at the wrong moment would mean the customer is never told.
 */
export const recheckIssueJob = defineTenantJob("github.recheck-issue", { linkId: z.uuid() });

/** How long before a check, and between checks while GitHub can't be reached. */
export const defaultRecheckSeconds = 120;
/** Checks stop a day after the link: the issue's own later webhooks still arrive. */
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
          createdAt: ticketGithubIssues.createdAt,
        })
        .from(ticketGithubIssues)
        .where(and(eq(ticketGithubIssues.id, linkId), eq(ticketGithubIssues.state, "open")));
      // Closed meanwhile (its webhook came after all), or gone: nothing to do.
      if (!link || link.number === null) return null;
      const [integration] = await tx
        .select({ tokenCiphertext: integrations.tokenCiphertext })
        .from(integrations)
        .where(eq(integrations.provider, "github"));
      // Disconnected: there is no token to ask with.
      if (!integration) return null;
      try {
        const token = deps.secretBox.open(integration.tokenCiphertext, {
          tenantId,
          purpose: "github-token",
        });
        return { ...link, number: link.number, token };
      } catch (error) {
        if (!(error instanceof SecretBoxError)) throw error;
        deps.logger.warn({ tenantId }, "github recheck: stored token can't be read");
        return null;
      }
    });
    if (!target) return;
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
      if (Date.now() - target.createdAt.getTime() > recheckForMs) {
        deps.logger.warn({ linkId, reason: now.reason }, "github recheck: giving up");
        return;
      }
      // Later, not at once: pg-boss would retry a thrown job straight away, into the outage.
      await transaction((tx) =>
        enqueue(tx, recheckIssueJob, payload, { startAfter: recheckAfter(deps.recheckSeconds) }),
      );
      return;
    }
    // Still open: its own webhook says when it closes.
    if (now.value.state !== "closed") return;
    const changed = await transaction((tx) =>
      markIssueClosed(tx, {
        tenantId,
        repo: target.repo,
        number: target.number,
        stateReason: now.value.stateReason,
        changedAt: now.value.updatedAt,
        actor: githubWebhookActor,
        requestId: null,
        noticeDelaySeconds: deps.noticeDelaySeconds,
      }),
    );
    deps.logger.info({ linkId, tickets: changed }, "github recheck: issue was closed");
  };
}
