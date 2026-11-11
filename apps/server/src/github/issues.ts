import { sanitizeIssue } from "@helpos/ai";
import { and, type Database, eq, lt, schema, sql, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import type { Auditor } from "../audit/audit.ts";
import { nothingToAudit } from "../audit/audit.ts";
import type { SecretBox } from "../secrets/secret-box.ts";
import type { ServerConfig } from "../services.ts";
import { githubWebhookActor } from "./fixed-notice.ts";
import {
  type CreatedIssue,
  type GithubApiFactory,
  type GithubFailure,
  type GithubResult,
  parseRepo,
  type RepoName,
  repoString,
} from "./github-api.ts";
import { openGithubAccess } from "./integration.ts";
import { markIssueClosed } from "./issue-state.ts";
import { enqueueRecheck } from "./recheck.ts";

const { conversationGithubIssues, conversations } = schema;

/**
 * Making a GitHub issue from a conversation, in four steps. GitHub can't make opening an issue
 * idempotent and a call to it can't sit inside a transaction, so the flow is built to lose
 * nothing when any step dies:
 *
 * 1. `claimSlot`: claim the conversation's issue slot, so a double click can't open two issues.
 * 2. `openOnGithub`: call GitHub with no transaction open. The claim's ID is hidden in the
 *    issue's body, so an answer that is lost can be found again by it.
 * 3. `linkIssue`: record the issue, with its audit event. It exists on GitHub now, so this is
 *    tried twice, and a failure still tells the caller where the issue is.
 * 4. `applyEarlyClose`: the issue may be closed already; if that can't be found out, a
 *    background job checks later.
 *
 * Nothing here knows HTTP: it returns what happened, and the route says it in status codes.
 */

/**
 * A `creating` claim older than this belongs to a request that died; the next try takes over.
 * Longer than one request can take, so a slow but live one is never taken over: its GitHub
 * calls are bounded (two issue searches of at most a minute each, plus the ten-second page
 * that may still be running when that minute ends, and a create and a state read of at most ten
 * seconds each), about three minutes at worst.
 */
const staleClaimSeconds = 300;

/** A minute of slack for clocks that disagree with GitHub's. */
const clockSlackMs = 60_000;

type GithubApi = ReturnType<GithubApiFactory>;

export interface CreateIssueDeps {
  db: Pick<Database, "withTenant">;
  logger: Pick<Logger, "info" | "warn" | "error">;
  secretBox: SecretBox;
  github: GithubApiFactory;
  config: Pick<ServerConfig, "noticeDelaySeconds" | "issueRecheckSeconds">;
}

export interface CreateIssueInput {
  tenantId: string;
  conversationId: string;
  /** The text as written by the caller; `author` says how far to trust it. */
  issue: { title: string; body: string };
  author: "agent" | "human";
  audit: Auditor;
  requestId: string | null;
}

type IssueLink = { repo: string; number: number; url: string; state: "open" | "closed" };

/** Why a claim was refused. A caller can act on each: connect, wait, or stop. */
type ClaimRefusal = "not_connected" | "reconnect_required" | "creation_pending" | "already_linked";

export type CreateIssueOutcome =
  | { kind: "created"; link: IssueLink }
  | { kind: "not_found" }
  | { kind: "conflict"; error: ClaimRefusal }
  /** No issue was opened (a refusal), or it is not known whether one was (`github_outcome_unknown`). */
  | { kind: "github_failed"; error: GithubFailure | "github_outcome_unknown" }
  /** The issue exists on GitHub, at `url`, but the conversation doesn't link to it. */
  | { kind: "not_linked"; url: string };

type Stop = Exclude<CreateIssueOutcome, { kind: "created" }>;

/**
 * An agent may have been steered by the customer text it read, so its text is cleaned like an
 * AI draft. A person's text is sent as written: they may add a link or @mention on purpose.
 */
export function issueText(
  written: { title: string; body: string },
  author: "agent" | "human",
): { title: string; body: string } {
  return author === "agent" ? sanitizeIssue(written) : written;
}

export async function createIssue(
  deps: CreateIssueDeps,
  input: CreateIssueInput,
): Promise<CreateIssueOutcome> {
  const issue = issueText(input.issue, input.author);
  const claim = await claimSlot(deps, input);
  if (claim.kind !== "claimed") return claim;

  const github = deps.github(claim.token);
  const opened = await openOnGithub(deps, input, claim, github, issue);
  if (opened.kind !== "opened") return opened;

  const link = await linkIssue(deps, input, claim, opened);
  if (link.kind !== "linked") return link;
  deps.logger.info(
    { conversationId: input.conversationId, issue: opened.issue.number },
    "github issue created",
  );

  const state = await applyEarlyClose(deps, input, github, link, opened);
  return {
    kind: "created",
    link: { repo: link.repo, number: opened.issue.number, url: opened.issue.url, state },
  };
}

// 1. Claim ---------------------------------------------------------------------------------

type StaleClaim = { id: string; repo: string; createdAt: Date; updatedAt: Date };
type Claim = {
  kind: "claimed";
  claimId: string;
  /** The connected repo. */
  repo: string;
  token: string;
  /** An earlier try's claim this request took over: its issue may exist already. */
  stale: StaleClaim | undefined;
};

async function claimSlot(deps: CreateIssueDeps, input: CreateIssueInput): Promise<Claim | Stop> {
  const { tenantId, conversationId } = input;
  return deps.db.withTenant(tenantId, async (tx): Promise<Claim | Stop> => {
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conversation) return { kind: "not_found" };
    const access = await openGithubAccess(tx, deps.secretBox, tenantId);
    if (access === "not_connected" || access === "reconnect_required") {
      return { kind: "conflict", error: access };
    }
    const { repo, token } = access;
    // A claim whose request died or never heard back from GitHub doesn't block the conversation for
    // good: this request takes it over, as it is, ID and all. That request's issue may exist
    // with this ID as its marker, so it is looked for first, and if this request fails too,
    // the claim (and so its marker) is still there for the next one. Locked, so two requests
    // can't both take it over.
    const stale = await takeOverStaleClaim(tx, conversationId);
    if (stale) return { kind: "claimed", claimId: stale.id, repo, token, stale };
    const [claimed] = await tx
      .insert(conversationGithubIssues)
      .values({ tenantId, conversationId, repo, state: "creating" })
      .onConflictDoNothing({
        target: [conversationGithubIssues.tenantId, conversationGithubIssues.conversationId],
      })
      .returning({ id: conversationGithubIssues.id });
    if (claimed) return { kind: "claimed", claimId: claimed.id, repo, token, stale: undefined };
    const [existing] = await tx
      .select({ state: conversationGithubIssues.state })
      .from(conversationGithubIssues)
      .where(eq(conversationGithubIssues.conversationId, conversationId));
    // Another request is opening it right now, or GitHub never told us how it went.
    return {
      kind: "conflict",
      error: existing?.state === "creating" ? "creation_pending" : "already_linked",
    };
  });
}

/** Locks the conversation's `creating` claim if it is stale, and makes it fresh for this request. */
async function takeOverStaleClaim(
  tx: TenantTx,
  conversationId: string,
): Promise<StaleClaim | undefined> {
  const [stale] = await tx
    .select({
      id: conversationGithubIssues.id,
      repo: conversationGithubIssues.repo,
      createdAt: conversationGithubIssues.createdAt,
      updatedAt: conversationGithubIssues.updatedAt,
    })
    .from(conversationGithubIssues)
    .where(
      and(
        eq(conversationGithubIssues.conversationId, conversationId),
        eq(conversationGithubIssues.state, "creating"),
        lt(
          conversationGithubIssues.updatedAt,
          sql`now() - make_interval(secs => ${staleClaimSeconds})`,
        ),
      ),
    )
    .for("update");
  if (!stale) return undefined;
  await tx
    .update(conversationGithubIssues)
    .set({ updatedAt: new Date() })
    .where(eq(conversationGithubIssues.id, stale.id));
  return stale;
}

/** Drops a claim that never became a link, so the conversation can try again. */
function releaseClaim(deps: CreateIssueDeps, tenantId: string, claimId: string) {
  return deps.db.withTenant(tenantId, (tx) =>
    tx
      .delete(conversationGithubIssues)
      .where(
        and(
          eq(conversationGithubIssues.id, claimId),
          eq(conversationGithubIssues.state, "creating"),
        ),
      ),
  );
}

// 2. Open on GitHub ------------------------------------------------------------------------

type Opened = {
  kind: "opened";
  issue: CreatedIssue;
  /** The repo the issue is in: the connected one, unless an earlier try's is adopted. */
  repo: string;
};

/** What to do after looking for the issue a dead request may have opened. */
export type EarlierLookup =
  | { action: "adopt"; issue: CreatedIssue }
  | { action: "open_new" }
  /** Not known whether that issue exists: stop, and let a later try search again. */
  | { action: "unknown"; reason: GithubFailure };

/**
 * Reads the answer to "is there an issue carrying the stale claim's marker?". A definite
 * refusal for another repo than the connected one means the token can't see it any more (the
 * workspace switched repos). Asking again never changes that, so it must not block the conversation
 * for good: the old claim is dropped and a new issue opened.
 */
export function judgeEarlierLookup(
  earlier: GithubResult<CreatedIssue | null>,
  staleRepo: RepoName,
  connectedRepo: RepoName,
): EarlierLookup {
  if (earlier.ok)
    return earlier.value ? { action: "adopt", issue: earlier.value } : { action: "open_new" };
  const unreachable =
    earlier.reason !== "github_unavailable" && repoString(staleRepo) !== repoString(connectedRepo);
  return unreachable ? { action: "open_new" } : { action: "unknown", reason: earlier.reason };
}

async function openOnGithub(
  deps: CreateIssueDeps,
  input: CreateIssueInput,
  claim: Claim,
  github: GithubApi,
  issue: { title: string; body: string },
): Promise<Opened | Stop> {
  const { tenantId, conversationId } = input;
  const repo = parseRepo(claim.repo);
  if (!repo) throw new Error("github issue: stored repo is not owner/name");

  if (claim.stale) {
    const stale = claim.stale;
    // In the repo that claim was for: the workspace may have switched repos since.
    const staleRepo = parseRepo(stale.repo) ?? repo;
    const earlier = judgeEarlierLookup(
      await github.findIssue(staleRepo, {
        marker: claim.claimId,
        since: new Date(stale.createdAt.getTime() - clockSlackMs),
      }),
      staleRepo,
      repo,
    );
    if (earlier.action === "unknown") {
      // The claim keeps its ID, so its marker is still searched; it is made stale again, so the
      // next try needn't wait to search. If even that fails, the claim is just fresh for a
      // while: nothing is lost.
      try {
        await deps.db.withTenant(tenantId, (tx) =>
          tx
            .update(conversationGithubIssues)
            .set({ updatedAt: stale.updatedAt })
            .where(
              and(
                eq(conversationGithubIssues.id, claim.claimId),
                eq(conversationGithubIssues.state, "creating"),
              ),
            ),
        );
      } catch (error) {
        deps.logger.warn({ err: error, conversationId }, "github issue: claim kept fresh");
      }
      // What GitHub said: a revoked token should be fixed, not retried forever.
      return { kind: "github_failed", error: earlier.reason };
    }
    if (earlier.action === "adopt") {
      return { kind: "opened", issue: earlier.issue, repo: stale.repo };
    }
    if (stale.repo !== claim.repo) {
      // A new issue goes in the connected repo: the claim says so, so a later search for its
      // marker looks there.
      await deps.db.withTenant(tenantId, (tx) =>
        tx
          .update(conversationGithubIssues)
          .set({ repo: claim.repo })
          .where(eq(conversationGithubIssues.id, claim.claimId)),
      );
    }
  }

  // The wall clock, not a service clock: this is compared with GitHub's own timestamps.
  const since = new Date(Date.now() - clockSlackMs);
  let created = await github.createIssue(repo, { ...issue, marker: claim.claimId });
  if (!created.ok && created.uncertain) {
    // GitHub may have opened it before the answer was lost. Opening it again would make a
    // duplicate that no conversation ever hears about, so look for this claim's marker first.
    const found = await github.findIssue(repo, { marker: claim.claimId, since });
    if (found.ok && found.value) created = { ok: true, value: found.value };
    else {
      // Still unknown. The claim stays, so a retry can't open a second issue now; once it is
      // stale, the next try looks for this marker again before opening anything.
      deps.logger.warn({ conversationId }, "github issue: GitHub's answer was lost");
      return { kind: "github_failed", error: "github_outcome_unknown" };
    }
  }
  if (!created.ok) {
    await releaseClaim(deps, tenantId, claim.claimId);
    deps.logger.warn({ conversationId, reason: created.reason }, "github issue: GitHub refused");
    return { kind: "github_failed", error: created.reason };
  }
  return { kind: "opened", issue: created.value, repo: claim.repo };
}

// 3. Link ----------------------------------------------------------------------------------

type Linked = { kind: "linked"; id: string; repo: string };

async function linkIssue(
  deps: CreateIssueDeps,
  input: CreateIssueInput,
  claim: Claim,
  opened: Opened,
): Promise<Linked | Stop> {
  const { tenantId, conversationId } = input;
  let link: { id: string; repo: string } | "taken" | undefined;
  for (let attempt = 1; attempt <= 2 && link === undefined; attempt++) {
    try {
      link = await deps.db.withTenant(tenantId, (tx) =>
        recordIssue(tx, {
          tenantId,
          conversationId,
          claimId: claim.claimId,
          repo: opened.repo,
          issue: opened.issue,
          audit: input.audit,
        }),
      );
    } catch (error) {
      deps.logger.warn({ err: error, attempt }, "github issue: linking failed");
    }
  }
  if (link !== undefined && link !== "taken") return { kind: "linked", ...link };
  deps.logger.error(
    { conversationId, issue: opened.issue.number, issueUrl: opened.issue.url },
    "github issue created but not linked to its conversation",
  );
  if (link === "taken") {
    // This conversation can't have that issue (another conversation has it, or another claim took this
    // conversation). Its own claim, if still there, is released, so the conversation isn't held for
    // minutes only to find the same issue again: a new try opens a new one.
    try {
      await releaseClaim(deps, tenantId, claim.claimId);
    } catch (error) {
      deps.logger.warn({ err: error, conversationId }, "github issue: claim not released");
    }
  }
  return { kind: "not_linked", url: opened.issue.url };
}

/**
 * Links an issue GitHub has opened to its conversation: on this request's own claim, or, when that
 * claim is gone (a request so slow its claim was taken as stale), as a new link. Idempotent: if
 * the conversation already links this very issue (an earlier attempt committed but its answer was
 * lost), that is success, not a clash. "taken" when the conversation has another issue or claim.
 */
async function recordIssue(
  tx: TenantTx,
  input: {
    tenantId: string;
    conversationId: string;
    claimId: string;
    repo: string;
    issue: CreatedIssue;
    audit: Auditor;
  },
): Promise<{ id: string; repo: string } | "taken"> {
  const values = {
    state: "open" as const,
    // The issue's own repo: an earlier claim's issue may be in a repo connected before.
    repo: input.repo,
    issueNumber: input.issue.number,
    issueUrl: input.issue.url,
  };
  // An issue linked to another conversation stays that conversation's: its "fixed" notice must never reach
  // this conversation's customer too. (The unique index enforces it; this keeps the answer typed.)
  const [elsewhere] = await tx
    .select({ conversationId: conversationGithubIssues.conversationId })
    .from(conversationGithubIssues)
    .where(
      and(
        eq(conversationGithubIssues.repo, input.repo),
        eq(conversationGithubIssues.issueNumber, input.issue.number),
      ),
    );
  if (elsewhere && elsewhere.conversationId !== input.conversationId) return "taken";
  const [claimed] = await tx
    .update(conversationGithubIssues)
    .set(values)
    .where(
      and(
        eq(conversationGithubIssues.id, input.claimId),
        eq(conversationGithubIssues.state, "creating"),
      ),
    )
    .returning({ id: conversationGithubIssues.id, repo: conversationGithubIssues.repo });
  const row =
    claimed ??
    (
      await tx
        .insert(conversationGithubIssues)
        .values({ tenantId: input.tenantId, conversationId: input.conversationId, ...values })
        .onConflictDoNothing({
          target: [conversationGithubIssues.tenantId, conversationGithubIssues.conversationId],
        })
        .returning({ id: conversationGithubIssues.id, repo: conversationGithubIssues.repo })
    )[0];
  if (!row) {
    const [existing] = await tx
      .select({
        id: conversationGithubIssues.id,
        repo: conversationGithubIssues.repo,
        issueNumber: conversationGithubIssues.issueNumber,
      })
      .from(conversationGithubIssues)
      .where(eq(conversationGithubIssues.conversationId, input.conversationId));
    const sameIssue = existing?.repo === input.repo && existing.issueNumber === input.issue.number;
    // Already linked and audited by the attempt that committed: nothing more to write.
    if (sameIssue) nothingToAudit("linked and audited by an earlier attempt");
    return sameIssue ? { id: existing.id, repo: existing.repo } : "taken";
  }
  await input.audit(tx, "github_issue.created", { type: "conversation", id: input.conversationId });
  return row;
}

// 4. Already closed? -----------------------------------------------------------------------

/**
 * The issue may already be closed: a fast maintainer, or an issue found again minutes later.
 * That close's webhook had no link to match, so apply it now, by the same rules. The issue
 * exists and is linked from here on, so nothing here may turn this into an error: a failure
 * leaves the state to a background recheck instead.
 */
async function applyEarlyClose(
  deps: CreateIssueDeps,
  input: CreateIssueInput,
  github: GithubApi,
  link: Linked,
  opened: Opened,
): Promise<"open" | "closed"> {
  const { tenantId, conversationId } = input;
  const recheckLater = async (why: string) => {
    deps.logger.warn({ conversationId }, `github issue: ${why}; rechecking later`);
    try {
      await deps.db.withTenant(tenantId, (tx) =>
        enqueueRecheck(tx, { tenantId, linkId: link.id }, deps.config),
      );
    } catch (error) {
      deps.logger.warn({ err: error, conversationId }, "github issue: recheck not queued");
    }
  };
  const linkedRepo = parseRepo(link.repo);
  const now = linkedRepo ? await github.issueState(linkedRepo, opened.issue.number) : null;
  if (now?.ok && now.value.state === "closed") {
    try {
      return await deps.db.withTenant(tenantId, async (tx) => {
        await markIssueClosed(tx, {
          tenantId,
          repo: link.repo,
          number: opened.issue.number,
          stateReason: now.value.stateReason,
          changedAt: now.value.updatedAt,
          current: true,
          actor: githubWebhookActor,
          requestId: input.requestId,
          noticeDelaySeconds: deps.config.noticeDelaySeconds,
        });
        // The link's own state: closed here, or already by the close's webhook, which can
        // arrive between linking and this check (then nothing changed here, but it is closed).
        const [row] = await tx
          .select({ state: conversationGithubIssues.state })
          .from(conversationGithubIssues)
          .where(eq(conversationGithubIssues.conversationId, conversationId));
        return row?.state === "closed" ? "closed" : "open";
      });
    } catch (error) {
      deps.logger.warn({ err: error, conversationId }, "github issue: close not applied");
      await recheckLater("close not applied");
    }
  } else if (now && !now.ok) {
    // A close before the link had no link to match, and its webhook won't come again. An
    // outage passes and a refused token can be fixed, so the worker reads it later.
    await recheckLater(`state not checked (${now.reason})`);
  }
  return "open";
}
