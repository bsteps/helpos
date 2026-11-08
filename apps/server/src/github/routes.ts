import { randomBytes } from "node:crypto";
import {
  draftGithubIssue,
  failedDraftCost,
  issueDraftTokenEstimate,
  type LanguageModel,
  maxIssueTitleChars,
  sanitizeIssue,
} from "@helpos/ai";
import {
  and,
  asc,
  type Database,
  enqueue,
  eq,
  isNull,
  lt,
  schema,
  sql,
  type TenantTx,
} from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { dailyBudget, reserveUsage, settleUsage, utcDay } from "../ai-budget/budget.ts";
import { errorSummary } from "../app.ts";
import { type AuditActor, recordAudit } from "../audit/audit.ts";
import { type Authenticate, requirePrincipal } from "../auth/principal.ts";
import { messageText } from "../drafts/html-text.ts";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { githubWebhookActor } from "./fixed-notice.ts";
import { type CreatedIssue, type GithubApiFactory, parseRepo, repoString } from "./github-api.ts";
import { markIssueClosed } from "./issue-state.ts";
import { recheckAfter, recheckIssueJob } from "./recheck.ts";
import { registerGithubWebhook, webhookPath } from "./webhook.ts";
import {
  createWebhookSecrets,
  defaultWebhookSecretsOptions,
  type WebhookSecrets,
} from "./webhook-secrets.ts";

const { integrations, messages, ticketGithubIssues, tickets } = schema;

export interface GithubRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** HELPOS_PUBLIC_URL: the webhook address shown to the admin is built from it. */
  publicUrl: string;
  /** From HELPOS_ENCRYPTION_KEY. Without it, nothing can be connected and nothing is decrypted. */
  secretBox: SecretBox | undefined;
  github: GithubApiFactory;
  /** Drafts the issue. Without it, drafting answers 503; an issue can still be written by hand. */
  model: LanguageModel | undefined;
  dailyTokenBudget: number;
  now?: () => Date;
  noticeDelaySeconds?: number | undefined;
  /** For tests: how long before a failed state check is tried again in the background. */
  issueRecheckSeconds?: number | undefined;
  /** For tests: how long a webhook secret read from the database is trusted (see webhook-secrets). */
  webhookSecretCacheMs?: number | undefined;
}

/**
 * A `creating` claim older than this belongs to a request that died; the next try takes over.
 * Longer than one request can take, so a slow but live one is never taken over: its GitHub
 * calls are bounded (two issue searches of at most a minute each, plus the ten-second page
 * that may still be running when that minute ends, and a create and a state read of at most ten
 * seconds each), about three minutes at worst.
 */
const staleClaimSeconds = 300;

/** Thrown to roll back a stale claim's removal when another request claimed the ticket first. */
class ClaimTaken extends Error {}

const integrationPath = "/v1/integrations/github";

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const integrationSchema = z
  .object({
    connected: z.boolean(),
    /** `owner/name`, or null when no repo is connected. */
    repo: z.string().nullable(),
    /**
     * Where GitHub should send the repo's issue events: set it as the webhook's Payload URL,
     * with content type `application/json` and the `Issues` event. Null when not connected.
     */
    webhookUrl: z.string().nullable(),
  })
  .openapi("GithubIntegration");
const connectedSchema = integrationSchema
  .extend({
    /**
     * The webhook's new secret, shown only in this response: store it in GitHub's webhook
     * settings right away. Null when the secret didn't change (the same repo connected again,
     * e.g. with a new token): the webhook already set up keeps working.
     */
    webhookSecret: z.string().nullable(),
  })
  .openapi("GithubConnected");
const issueLinkSchema = z
  .object({
    repo: z.string(),
    number: z.int(),
    url: z.string(),
    /** `closed` once GitHub says the issue was closed. */
    state: z.enum(["open", "closed"]),
  })
  .openapi("GithubIssueLink");
const issueDraftSchema = z
  .object({
    /** Suggested title. Edit it before creating the issue. */
    title: z.string(),
    /**
     * Suggested markdown body: summary, steps to reproduce, expected and actual. It never
     * contains links, email addresses, @mentions or issue references, whatever the ticket says.
     */
    body: z.string(),
  })
  .openapi("GithubIssueDraft");

const json = <T extends z.ZodType>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});
const security = [{ apiAuth: [] }];
const authErrors = {
  401: json(errorSchema, "No valid credentials"),
  403: json(errorSchema, "The credentials lack the required scope"),
};
const idParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });
const notConfigured = json(
  errorSchema,
  "The server has no HELPOS_ENCRYPTION_KEY (`encryption_not_configured`), so no token can be stored or used",
);

const getRoute = createRoute({
  method: "get",
  path: integrationPath,
  summary: "Read the workspace's GitHub connection",
  description:
    "Which repo is connected, and the webhook address to give GitHub. Never includes the " +
    "token or the webhook secret. Needs `github:write`, or `workspace:admin`.",
  security,
  responses: { 200: json(integrationSchema, "The connection"), ...authErrors },
});

const connectRoute = createRoute({
  method: "put",
  path: integrationPath,
  summary: "Connect a GitHub repo",
  description:
    "Stores one repo and a fine-grained personal access token (`github_pat_…`) with Issues " +
    "read and write access to it; classic tokens are refused (400). Replaces any earlier connection. The token is checked with GitHub first, " +
    "then stored encrypted; it is never returned. The response holds a new webhook secret, the " +
    "only time it is shown; connecting the same repo again (a new token) keeps the secret unless " +
    "`rotateWebhookSecret` is set, so the webhook already in GitHub keeps working. Needs " +
    "`workspace:admin` in a human session.",
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            repo: z
              .string()
              .max(140)
              .refine((r) => parseRepo(r) !== null, "must be owner/name"),
            token: z
              .string()
              .trim()
              // Fine-grained tokens only: a classic `ghp_` token reaches every repo its owner
              // can, and the helpdesk must reach only the one it is connected to.
              .regex(/^github_pat_[A-Za-z0-9_]{20,250}$/, "must be a fine-grained token"),
            /** Make a new webhook secret even when the repo is the same, e.g. after a leak. */
            rotateWebhookSecret: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: json(connectedSchema, "Connected"),
    ...authErrors,
    422: json(
      errorSchema,
      "GitHub refused the token (`token_rejected`), or the token can't see the repo " +
        "(`repo_not_found`)",
    ),
    502: json(errorSchema, "GitHub could not be reached (`github_unavailable`)"),
    503: notConfigured,
  },
});

const disconnectRoute = createRoute({
  method: "delete",
  path: integrationPath,
  summary: "Disconnect the GitHub repo",
  description:
    "Deletes the stored token and webhook secret. Tickets keep their issue links, and webhooks " +
    "are refused from now on. Needs `workspace:admin` in a human session.",
  security,
  responses: { 204: { description: "Disconnected, or nothing was connected" }, ...authErrors },
});

const rotatePath = `${integrationPath}/webhook-secret`;
const rotateRoute = createRoute({
  method: "post",
  path: rotatePath,
  summary: "Give the GitHub webhook a new secret",
  description:
    "Replaces the webhook secret, e.g. after it leaked, and returns the new one: this is the " +
    "only time it is shown. Paste it into the repo's webhook settings right away; until then " +
    "GitHub's deliveries are refused. The token is kept. Needs `workspace:admin` in a human " +
    "session.",
  security,
  responses: {
    200: json(
      z.object({ webhookSecret: z.string() }).openapi("GithubWebhookSecret"),
      "The new secret",
    ),
    ...authErrors,
    404: json(errorSchema, "No repo is connected (`not_connected`)"),
    503: notConfigured,
  },
});

const draftIssueRoute = createRoute({
  method: "post",
  path: "/v1/tickets/{id}/github-issue/draft",
  summary: "Ask the AI to draft a GitHub issue from a ticket",
  description:
    "Suggests a title and body (steps to reproduce, expected, actual) from the ticket's " +
    "messages. Nothing is created: edit the text, then create the issue. The customer's text " +
    "is data, never instructions, so the draft has no labels, assignees, links, @mentions or " +
    "issue references. Counts against the AI daily budget. Needs `tickets:read` and `github:write`.",
  security,
  request: { params: idParams },
  responses: {
    200: json(issueDraftSchema, "The suggested issue"),
    ...authErrors,
    404: json(errorSchema, "Not found in this workspace"),
    409: json(
      errorSchema,
      "No message from the customer to work from (`nothing_to_report`), or today's AI budget " +
        "is spent (`daily_budget_reached`)",
    ),
    502: json(errorSchema, "The AI provider failed (`ai_unavailable`)"),
    503: json(errorSchema, "AI is not configured on this server (`ai_not_configured`)"),
  },
});

const createIssueRoute = createRoute({
  method: "post",
  path: "/v1/tickets/{id}/github-issue",
  summary: "Create a GitHub issue from a ticket",
  description:
    "Opens an issue with exactly this title and body in the connected repo, and links it to " +
    "the ticket. Only title and body are sent: no labels, assignees or milestones. The body " +
    "ends with an HTML comment GitHub doesn't show, `<!-- helpdesk-claim:<id> -->`, so that " +
    "if GitHub's answer is lost (a timeout, a 5xx) the server can find exactly this issue " +
    "instead of opening a duplicate. When the issue is closed as completed, the ticket gets a " +
    "`fixed` draft to approve. One issue per ticket. Needs `tickets:read` and `github:write`.",
  security,
  request: {
    params: idParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            title: z.string().trim().min(1).max(maxIssueTitleChars),
            body: z.string().max(60_000),
          }),
        },
      },
    },
  },
  responses: {
    201: json(issueLinkSchema, "The issue, now linked to the ticket"),
    ...authErrors,
    404: json(errorSchema, "Not found in this workspace"),
    409: json(
      errorSchema,
      "No repo is connected (`not_connected`), the ticket already has an issue " +
        "(`already_linked`), one is being opened or GitHub's answer to the last try was lost " +
        "(`creation_pending`: try again in five minutes; nothing is opened twice), or the stored " +
        "token can't be read with the server's key and the repo must be connected again " +
        "(`reconnect_required`)",
    ),
    502: json(
      errorSchema,
      "GitHub refused the token (`token_rejected`), can't see the repo (`repo_not_found`), " +
        "refused the issue itself, e.g. as too long (`issue_rejected`), or could not be reached " +
        "(`github_unavailable`): no issue was opened. Or GitHub didn't " +
        "answer and the issue isn't found either (`github_outcome_unknown`): the ticket stays " +
        "claimed, and a try after five minutes first looks for that issue again",
    ),
    500: json(
      z.object({ error: z.string(), url: z.string() }),
      "The issue was opened on GitHub, at `url`, but couldn't be linked to the ticket " +
        "(`issue_not_linked`). Don't create it again: close that one or link it by hand",
    ),
    503: notConfigured,
  },
});

/** Whether the stored webhook secret still opens with the current key. */
function readable(box: SecretBox, sealed: string, tenantId: string): boolean {
  try {
    box.open(sealed, { tenantId, purpose: "github-webhook-secret" });
    return true;
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    return false;
  }
}

export function webhookUrl(publicUrl: string, tenantId: string): string {
  // Keeps any path in the public URL (e.g. `https://acme.test/helpdesk`).
  const base = publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`;
  const url = new URL(webhookPath.slice(1), base);
  url.searchParams.set("workspace", tenantId);
  return url.toString();
}

export function registerGithubRoutes(app: OpenAPIHono, deps: GithubRoutesDeps): void {
  const auth = requirePrincipal(deps.authenticate);
  // The exact path only: the webhook below authenticates with its signature instead.
  app.use(integrationPath, auth);
  app.use(rotatePath, auth);
  // Only this feature's ticket paths: the ticket and draft routes authenticate their own.
  app.use("/v1/tickets/:id/github-issue", auth);
  app.use("/v1/tickets/:id/github-issue/draft", auth);

  // Read by the webhook, forgotten here whenever the secret changes.
  const secrets = createWebhookSecrets(
    deps.webhookSecretCacheMs === undefined
      ? defaultWebhookSecretsOptions
      : { ...defaultWebhookSecretsOptions, maxAgeMs: deps.webhookSecretCacheMs },
  );
  registerConnectionRoutes(app, deps, secrets);
  registerIssueRoutes(app, deps);
  registerGithubWebhook(app, { ...deps, secrets });
}

function registerConnectionRoutes(
  app: OpenAPIHono,
  deps: GithubRoutesDeps,
  secrets: WebhookSecrets,
): void {
  app.openapi(getRoute, async (c) => {
    const principal = c.get("principal");
    // An admin may read it too: they connect and disconnect, so they must see what's there.
    if (!principal.scopes.has("github:write") && !principal.scopes.has("workspace:admin")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const [row] = await deps.db.withTenant(principal.tenantId, (tx) =>
      tx
        .select({ repo: integrations.repo })
        .from(integrations)
        .where(eq(integrations.provider, "github")),
    );
    return c.json(
      {
        connected: row !== undefined,
        repo: row?.repo ?? null,
        webhookUrl: row ? webhookUrl(deps.publicUrl, principal.tenantId) : null,
      },
      200,
    );
  });

  app.openapi(connectRoute, async (c) => {
    const principal = c.get("principal");
    // A token is a credential to the customer's code host: only a human admin stores one.
    if (principal.actor.type !== "user" || !principal.scopes.has("workspace:admin")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const box = deps.secretBox;
    if (!box) return c.json({ error: "encryption_not_configured" }, 503);
    const input = c.req.valid("json");
    const repo = parseRepo(input.repo);
    if (!repo) return c.json({ error: "invalid_repo" }, 422);

    const check = await deps.github(input.token).checkRepo(repo);
    if (!check.ok) {
      deps.logger.warn({ reason: check.reason }, "github connect: GitHub refused");
      return check.reason === "github_unavailable"
        ? c.json({ error: check.reason }, 502)
        : c.json({ error: check.reason }, 422);
    }

    const { tenantId } = principal;
    const tokenCiphertext = box.seal(input.token, { tenantId, purpose: "github-token" });
    const webhookSecret = await deps.db.withTenant(tenantId, async (tx) => {
      // One connect per workspace at a time. A row lock isn't enough: when there is no row yet,
      // it locks nothing, and two first connects would both insert.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`github-connect:${tenantId}`}, 0))`,
      );
      const [current] = await tx
        .select({
          repo: integrations.repo,
          webhookSecretCiphertext: integrations.webhookSecretCiphertext,
        })
        .from(integrations)
        .where(eq(integrations.provider, "github"));
      // Same repo (a new token, say): the webhook set up in GitHub keeps working. Another repo
      // needs a webhook of its own, so it gets a new secret to paste there, as does asking. So
      // does a secret that can't be read any more (a new key): keeping it would keep the
      // webhook broken, when reconnecting is what the webhook's own warning says to do.
      const keep =
        current?.repo === repoString(repo) &&
        !input.rotateWebhookSecret &&
        readable(box, current.webhookSecretCiphertext, tenantId);
      const secret = keep ? null : randomBytes(32).toString("hex");
      const sealedSecret = secret
        ? box.seal(secret, { tenantId, purpose: "github-webhook-secret" })
        : null;
      const values = {
        repo: repoString(repo),
        tokenCiphertext,
        ...(sealedSecret ? { webhookSecretCiphertext: sealedSecret } : {}),
      };
      let row: { id: string } | undefined;
      if (current) {
        [row] = await tx
          .update(integrations)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(integrations.provider, "github"))
          .returning({ id: integrations.id });
      } else {
        // A first connection always gets a new secret (nothing to keep): never an empty one.
        if (!sealedSecret) throw new Error("github connect: a new connection has no secret");
        [row] = await tx
          .insert(integrations)
          .values({
            tenantId,
            provider: "github",
            ...values,
            webhookSecretCiphertext: sealedSecret,
          })
          .returning({ id: integrations.id });
      }
      if (!row) throw new Error("github connect: write returned no row");
      await recordAudit(tx, {
        tenantId,
        actor: principal.actor,
        action: "github.connected",
        target: { type: "integration", id: row.id },
        requestId: c.get("requestId"),
      });
      return secret;
    });
    secrets.forget(tenantId);
    // Never cached: when there is a new secret, the response is its only copy.
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        connected: true,
        repo: repoString(repo),
        webhookUrl: webhookUrl(deps.publicUrl, tenantId),
        webhookSecret,
      },
      200,
    );
  });

  app.openapi(rotateRoute, async (c) => {
    const principal = c.get("principal");
    if (principal.actor.type !== "user" || !principal.scopes.has("workspace:admin")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const box = deps.secretBox;
    if (!box) return c.json({ error: "encryption_not_configured" }, 503);
    const { tenantId } = principal;
    const secret = randomBytes(32).toString("hex");
    const sealed = box.seal(secret, { tenantId, purpose: "github-webhook-secret" });
    const rotated = await deps.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .update(integrations)
        .set({ webhookSecretCiphertext: sealed, updatedAt: new Date() })
        .where(eq(integrations.provider, "github"))
        .returning({ id: integrations.id });
      if (!row) return false;
      await recordAudit(tx, {
        tenantId,
        actor: principal.actor,
        action: "github.webhook_secret_rotated",
        target: { type: "integration", id: row.id },
        requestId: c.get("requestId"),
      });
      return true;
    });
    if (!rotated) return c.json({ error: "not_connected" }, 404);
    // The old secret stops working now, not once the webhook's copy of it expires.
    secrets.forget(tenantId);
    // Never cached: the response is the secret's only copy.
    c.header("Cache-Control", "no-store");
    return c.json({ webhookSecret: secret }, 200);
  });

  app.openapi(disconnectRoute, async (c) => {
    const principal = c.get("principal");
    if (principal.actor.type !== "user" || !principal.scopes.has("workspace:admin")) {
      return c.json({ error: "forbidden" }, 403);
    }
    await deps.db.withTenant(principal.tenantId, async (tx) => {
      const removed = await tx
        .delete(integrations)
        .where(eq(integrations.provider, "github"))
        .returning({ id: integrations.id });
      for (const { id } of removed) {
        await recordAudit(tx, {
          tenantId: principal.tenantId,
          actor: principal.actor,
          action: "github.disconnected",
          target: { type: "integration", id },
          requestId: c.get("requestId"),
        });
      }
    });
    secrets.forget(principal.tenantId);
    return c.body(null, 204);
  });
}

function registerIssueRoutes(app: OpenAPIHono, deps: GithubRoutesDeps): void {
  app.openapi(draftIssueRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("github:write") || !principal.scopes.has("tickets:read")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const model = deps.model;
    if (!model) return c.json({ error: "ai_not_configured" }, 503);
    const { id } = c.req.valid("param");
    const { tenantId } = principal;
    const day = utcDay((deps.now ?? (() => new Date()))());

    // 1. Read the ticket and reserve the call's cost from today's budget, in one statement:
    // concurrent calls can't all pass the cap, and no lock is held while the model writes, so
    // this never holds up the workspace's reply drafting.
    const prepared = await deps.db.withTenant(tenantId, async (tx) => {
      const [ticket] = await tx
        .select({ subject: tickets.subject })
        .from(tickets)
        .where(eq(tickets.id, id));
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
        .where(and(eq(messages.ticketId, id), isNull(messages.automatedReason)))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      const lastInbound = rows.findLastIndex((m) => m.direction === "inbound");
      const latest = rows[lastInbound];
      if (!latest) return "nothing_to_report" as const;
      const input = {
        from: latest.from,
        subject: ticket.subject,
        body: messageText(latest),
        history: rows.slice(0, lastInbound).map((m) => ({
          direction: m.direction,
          from: m.from,
          body: messageText(m),
        })),
      };
      const reserved = issueDraftTokenEstimate(input);
      const budget = await dailyBudget(tx, tenantId, deps.dailyTokenBudget);
      if (!(await reserveUsage(tx, tenantId, day, reserved, budget))) {
        return "daily_budget_reached" as const;
      }
      // Logged with the reservation, in its transaction: from here on the call is paid for.
      await recordAudit(tx, {
        tenantId,
        actor: principal.actor,
        action: "github_issue.drafted",
        target: { type: "ticket", id },
        requestId: c.get("requestId"),
      });
      return { input, reserved };
    });
    if (prepared === "not_found") return c.json({ error: prepared }, 404);
    if (typeof prepared === "string") return c.json({ error: prepared }, 409);

    // 2. The model call, with no transaction open.
    let draft: Awaited<ReturnType<typeof draftGithubIssue>>;
    try {
      draft = await draftGithubIssue(model, prepared.input);
    } catch (error) {
      deps.logger.warn({ err: errorSummary(error) }, "github issue draft: AI call failed");
      // Count what the failure cost: what the model reported when it answered, nothing when
      // the provider plainly refused, and when that can't be told, the reservation stays.
      const cost = failedDraftCost(error);
      if (cost !== "unknown") {
        try {
          await deps.db.withTenant(tenantId, (tx) =>
            settleUsage(tx, day, prepared.reserved, cost === "none" ? null : cost),
          );
        } catch (settleError) {
          // The reservation stays counted, so the budget may overcount, never undercount.
          deps.logger.warn(
            { err: errorSummary(settleError) },
            "github issue draft: usage not settled",
          );
        }
      }
      return c.json({ error: "ai_unavailable" }, 502);
    }

    // 3. Swap the reservation for the real cost. If that fails, the draft is still returned:
    // it is paid for, and the reservation (an upper bound) stays counted, so the budget may
    // overcount, never undercount.
    try {
      await deps.db.withTenant(tenantId, (tx) =>
        settleUsage(tx, day, prepared.reserved, draft.usage),
      );
    } catch (error) {
      deps.logger.warn({ err: errorSummary(error) }, "github issue draft: usage not settled");
    }
    return c.json({ title: draft.title, body: draft.body }, 200);
  });

  app.openapi(createIssueRoute, async (c) => {
    const principal = c.get("principal");
    // tickets:read too: the issue is made from the ticket, and the ticket's customer is who is
    // told when it's fixed, so a caller that can't read the ticket can't pick it either.
    if (!principal.scopes.has("github:write") || !principal.scopes.has("tickets:read")) {
      return c.json({ error: "forbidden" }, 403);
    }
    const box = deps.secretBox;
    if (!box) return c.json({ error: "encryption_not_configured" }, 503);
    const { id: ticketId } = c.req.valid("param");
    const written = c.req.valid("json");
    // An agent may have been steered by the customer text it read, so its text is cleaned like
    // an AI draft. A person's text is sent as written: they may add a link or @mention on purpose.
    const issue = principal.actor.type === "agent" ? sanitizeIssue(written) : written;
    const { tenantId } = principal;

    // 1. Claim the ticket's issue slot, so a double click can't open two issues.
    const claim = await deps.db
      .withTenant(tenantId, async (tx) => {
        const [ticket] = await tx
          .select({ id: tickets.id })
          .from(tickets)
          .where(eq(tickets.id, ticketId));
        if (!ticket) return "not_found" as const;
        const [integration] = await tx
          .select({ repo: integrations.repo, tokenCiphertext: integrations.tokenCiphertext })
          .from(integrations)
          .where(eq(integrations.provider, "github"));
        if (!integration) return "not_connected" as const;
        let token: string;
        try {
          token = box.open(integration.tokenCiphertext, { tenantId, purpose: "github-token" });
        } catch (error) {
          if (!(error instanceof SecretBoxError)) throw error;
          return "reconnect_required" as const;
        }
        // A claim whose request died or never heard back from GitHub doesn't block the ticket
        // for good. Its ID comes along: that request's issue may exist, and is looked for first.
        const stale = await tx
          .delete(ticketGithubIssues)
          .where(
            and(
              eq(ticketGithubIssues.ticketId, ticketId),
              eq(ticketGithubIssues.state, "creating"),
              lt(
                ticketGithubIssues.updatedAt,
                sql`now() - make_interval(secs => ${staleClaimSeconds})`,
              ),
            ),
          )
          .returning({
            id: ticketGithubIssues.id,
            repo: ticketGithubIssues.repo,
            createdAt: ticketGithubIssues.createdAt,
            updatedAt: ticketGithubIssues.updatedAt,
          });
        const [claimed] = await tx
          .insert(ticketGithubIssues)
          .values({ tenantId, ticketId, repo: integration.repo, state: "creating" })
          .onConflictDoNothing({
            target: [ticketGithubIssues.tenantId, ticketGithubIssues.ticketId],
          })
          .returning({ id: ticketGithubIssues.id });
        if (!claimed) {
          // Another request claimed the ticket between this one's removal of the stale claim and
          // its own: put the stale one back (by rolling back), so its marker is still searched.
          if (stale.length > 0) throw new ClaimTaken();
          const [existing] = await tx
            .select({ state: ticketGithubIssues.state })
            .from(ticketGithubIssues)
            .where(eq(ticketGithubIssues.ticketId, ticketId));
          // Another request is opening it right now, or GitHub never told us how it went.
          return existing?.state === "creating"
            ? ("creation_pending" as const)
            : ("already_linked" as const);
        }
        return { claimId: claimed.id, repo: integration.repo, token, stale: stale[0] };
      })
      .catch((error: unknown) => {
        if (error instanceof ClaimTaken) return "creation_pending" as const;
        throw error;
      });
    if (claim === "not_found") return c.json({ error: claim }, 404);
    if (typeof claim === "string") return c.json({ error: claim }, 409);

    // 2. Call GitHub with no transaction open: a slow GitHub holds no connection or lock.
    const repo = parseRepo(claim.repo);
    if (!repo) throw new Error("github issue: stored repo is not owner/name");
    const github = deps.github(claim.token);
    // A minute of slack for clocks that disagree with GitHub's.
    const slack = 60_000;
    let created: Awaited<ReturnType<typeof github.createIssue>> | undefined;
    // The repo the linked issue is in: the connected one, unless an earlier try's is adopted.
    let issueRepo = claim.repo;
    if (claim.stale) {
      // In the repo that claim was for: the workspace may have switched repos since.
      const staleRepo = parseRepo(claim.stale.repo) ?? repo;
      const earlier = await github.findIssue(staleRepo, {
        marker: claim.stale.id,
        since: new Date(claim.stale.createdAt.getTime() - slack),
      });
      // A definite refusal for another repo than the connected one means the token can't see
      // it any more (the workspace switched repos). Asking again never changes that, so it
      // must not block the ticket for good: the old claim is dropped and a new issue opened.
      const unreachable =
        !earlier.ok &&
        earlier.reason !== "github_unavailable" &&
        repoString(staleRepo) !== repoString(repo);
      if (!earlier.ok && !unreachable) {
        // The old claim was replaced by this request's, so its marker would never be looked for
        // again and its issue, if GitHub opened one, would be duplicated by the next try. Put
        // the old claim back, still stale, so the next try searches for its marker first.
        const old = claim.stale;
        await deps.db.withTenant(tenantId, async (tx) => {
          await tx
            .delete(ticketGithubIssues)
            .where(
              and(
                eq(ticketGithubIssues.id, claim.claimId),
                eq(ticketGithubIssues.state, "creating"),
              ),
            );
          await tx
            .insert(ticketGithubIssues)
            .values({
              id: old.id,
              tenantId,
              ticketId,
              repo: old.repo,
              state: "creating",
              createdAt: old.createdAt,
              // Its own timestamp, so it is exactly as stale as it was.
              updatedAt: old.updatedAt,
            })
            .onConflictDoNothing({
              target: [ticketGithubIssues.tenantId, ticketGithubIssues.ticketId],
            });
        });
        // What GitHub said: a revoked token should be fixed, not retried forever.
        return c.json({ error: earlier.ok ? "github_unavailable" : earlier.reason }, 502);
      }
      if (earlier.ok && earlier.value) {
        created = { ok: true, value: earlier.value };
        issueRepo = claim.stale.repo;
      }
    }
    if (!created) {
      // The wall clock, not deps.now: this is compared with GitHub's own timestamps.
      const since = new Date(Date.now() - slack);
      created = await github.createIssue(repo, { ...issue, marker: claim.claimId });
      if (!created.ok && created.uncertain) {
        // GitHub may have opened it before the answer was lost. Opening it again would make a
        // duplicate that no ticket ever hears about, so look for this claim's marker first.
        const found = await github.findIssue(repo, { marker: claim.claimId, since });
        if (found.ok && found.value) created = { ok: true, value: found.value };
        else {
          // Still unknown. The claim stays, so a retry can't open a second issue now; once it
          // is stale, the next try looks for this marker again before opening anything.
          deps.logger.warn({ ticketId }, "github issue: GitHub's answer was lost");
          return c.json({ error: "github_outcome_unknown" }, 502);
        }
      }
    }
    if (!created.ok) {
      await deps.db.withTenant(tenantId, (tx) =>
        tx
          .delete(ticketGithubIssues)
          .where(
            and(eq(ticketGithubIssues.id, claim.claimId), eq(ticketGithubIssues.state, "creating")),
          ),
      );
      deps.logger.warn({ ticketId, reason: created.reason }, "github issue: GitHub refused");
      return c.json({ error: created.reason }, 502);
    }
    const made = created.value;

    // 3. Record the issue, with its audit event. It exists on GitHub now, so a failure here
    // must not lose it: tried twice, and if it still fails, the caller gets its address.
    let link: { id: string; repo: string } | "taken" | undefined;
    for (let attempt = 1; attempt <= 2 && link === undefined; attempt++) {
      try {
        link = await deps.db.withTenant(tenantId, (tx) =>
          recordIssue(tx, {
            tenantId,
            ticketId,
            claimId: claim.claimId,
            repo: issueRepo,
            issue: made,
            actor: principal.actor,
            requestId: c.get("requestId"),
          }),
        );
      } catch (error) {
        deps.logger.warn({ err: errorSummary(error), attempt }, "github issue: linking failed");
      }
    }
    if (link === undefined || link === "taken") {
      deps.logger.error(
        { ticketId, issue: made.number, issueUrl: made.url },
        "github issue created but not linked to its ticket",
      );
      if (link === "taken") {
        // This ticket can't have that issue (another ticket has it, or another claim took
        // this ticket). Its own claim, if still there, is released, so the ticket isn't held
        // for minutes only to find the same issue again: a new try opens a new one.
        try {
          await deps.db.withTenant(tenantId, (tx) =>
            tx
              .delete(ticketGithubIssues)
              .where(
                and(
                  eq(ticketGithubIssues.id, claim.claimId),
                  eq(ticketGithubIssues.state, "creating"),
                ),
              ),
          );
        } catch (error) {
          deps.logger.warn(
            { err: errorSummary(error), ticketId },
            "github issue: claim not released",
          );
        }
      }
      return c.json({ error: "issue_not_linked", url: made.url }, 500);
    }
    deps.logger.info({ ticketId, issue: made.number }, "github issue created");

    // 4. The issue may already be closed: a fast maintainer, or an issue found again minutes
    // later. That close's webhook had no link to match, so apply it now, by the same rules.
    // The issue exists and is linked from here on, so nothing below may turn this into an
    // error: a failure leaves the state to a background recheck instead.
    const linked = link;
    const recheckLater = async (why: string) => {
      deps.logger.warn({ ticketId }, `github issue: ${why}; rechecking later`);
      try {
        await deps.db.withTenant(tenantId, (tx) =>
          enqueue(
            tx,
            recheckIssueJob,
            { tenantId, linkId: linked.id },
            { startAfter: recheckAfter(deps.issueRecheckSeconds) },
          ),
        );
      } catch (error) {
        deps.logger.warn(
          { err: errorSummary(error), ticketId },
          "github issue: recheck not queued",
        );
      }
    };
    let state: "open" | "closed" = "open";
    const linkedRepo = parseRepo(link.repo);
    const now = linkedRepo ? await github.issueState(linkedRepo, made.number) : null;
    if (now?.ok && now.value.state === "closed") {
      try {
        state = await deps.db.withTenant(tenantId, async (tx) => {
          await markIssueClosed(tx, {
            tenantId,
            repo: linked.repo,
            number: made.number,
            stateReason: now.value.stateReason,
            changedAt: now.value.updatedAt,
            current: true,
            actor: githubWebhookActor,
            requestId: c.get("requestId"),
            noticeDelaySeconds: deps.noticeDelaySeconds,
          });
          // The link's own state: closed here, or already by the close's webhook, which can
          // arrive between linking and this check (then nothing changed here, but it is closed).
          const [row] = await tx
            .select({ state: ticketGithubIssues.state })
            .from(ticketGithubIssues)
            .where(eq(ticketGithubIssues.ticketId, ticketId));
          return row?.state === "closed" ? "closed" : "open";
        });
      } catch (error) {
        deps.logger.warn({ err: errorSummary(error), ticketId }, "github issue: close not applied");
        await recheckLater("close not applied");
      }
    } else if (now && !now.ok && now.reason === "github_unavailable") {
      // A close before the link had no link to match, and its webhook won't come again.
      await recheckLater("state not checked");
    } else if (now && !now.ok) {
      // A refusal, not an outage: asking again won't help. A later close still arrives by webhook.
      deps.logger.warn({ ticketId, reason: now.reason }, "github issue: state not checked");
    }
    return c.json({ repo: link.repo, number: made.number, url: made.url, state }, 201);
  });
}

/**
 * Links an issue GitHub has opened to its ticket: on this request's own claim, or, when that
 * claim is gone (a request so slow its claim was taken as stale), as a new link. Idempotent: if
 * the ticket already links this very issue (an earlier attempt committed but its answer was
 * lost), that is success, not a clash. "taken" when the ticket has another issue or claim.
 */
async function recordIssue(
  tx: TenantTx,
  input: {
    tenantId: string;
    ticketId: string;
    claimId: string;
    repo: string;
    issue: CreatedIssue;
    actor: AuditActor;
    requestId: string;
  },
): Promise<{ id: string; repo: string } | "taken"> {
  const values = {
    state: "open" as const,
    // The issue's own repo: an earlier claim's issue may be in a repo connected before.
    repo: input.repo,
    issueNumber: input.issue.number,
    issueUrl: input.issue.url,
  };
  // An issue linked to another ticket stays that ticket's: its "fixed" notice must never reach
  // this ticket's customer too. (The unique index enforces it; this keeps the answer typed.)
  const [elsewhere] = await tx
    .select({ ticketId: ticketGithubIssues.ticketId })
    .from(ticketGithubIssues)
    .where(
      and(
        eq(ticketGithubIssues.repo, input.repo),
        eq(ticketGithubIssues.issueNumber, input.issue.number),
      ),
    );
  if (elsewhere && elsewhere.ticketId !== input.ticketId) return "taken";
  const [claimed] = await tx
    .update(ticketGithubIssues)
    .set(values)
    .where(and(eq(ticketGithubIssues.id, input.claimId), eq(ticketGithubIssues.state, "creating")))
    .returning({ id: ticketGithubIssues.id, repo: ticketGithubIssues.repo });
  const row =
    claimed ??
    (
      await tx
        .insert(ticketGithubIssues)
        .values({ tenantId: input.tenantId, ticketId: input.ticketId, ...values })
        .onConflictDoNothing({ target: [ticketGithubIssues.tenantId, ticketGithubIssues.ticketId] })
        .returning({ id: ticketGithubIssues.id, repo: ticketGithubIssues.repo })
    )[0];
  if (!row) {
    const [existing] = await tx
      .select({
        id: ticketGithubIssues.id,
        repo: ticketGithubIssues.repo,
        issueNumber: ticketGithubIssues.issueNumber,
      })
      .from(ticketGithubIssues)
      .where(eq(ticketGithubIssues.ticketId, input.ticketId));
    const sameIssue = existing?.repo === input.repo && existing.issueNumber === input.issue.number;
    // Already linked and audited by the attempt that committed: nothing more to write.
    return sameIssue ? { id: existing.id, repo: existing.repo } : "taken";
  }
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "github_issue.created",
    target: { type: "ticket", id: input.ticketId },
    requestId: input.requestId,
  });
  return row;
}
