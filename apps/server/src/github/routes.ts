import { type LanguageModel, maxIssueTitleChars } from "@helpos/ai";
import type { Database } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { nothingToAudit } from "../audit/audit.ts";
import { apiRoute } from "../auth/access.ts";
import {
  auditor,
  errorSchema,
  idParams,
  json,
  jsonBody,
  notFound,
  notFoundResponse,
} from "../http/route-kit.ts";
import type { SecretBox } from "../secrets/secret-box.ts";
import type { Clock, ServerConfig } from "../services.ts";
import { type GithubApiFactory, parseRepo, repoString } from "./github-api.ts";
import {
  connectedRepo,
  connectIntegration,
  removeIntegration,
  rotateWebhookSecret,
} from "./integration.ts";
import { draftIssue } from "./issue-draft.ts";
import { createIssue } from "./issues.ts";
import { registerGithubWebhook } from "./webhook.ts";
import {
  createWebhookSecrets,
  defaultWebhookSecretsOptions,
  type WebhookSecrets,
} from "./webhook-secrets.ts";
import { webhookUrl } from "./webhook-url.ts";

export interface GithubRoutesDeps {
  db: Pick<Database, "withTenant">;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** From HELPOS_ENCRYPTION_KEY. Without it, nothing can be connected and nothing is decrypted. */
  secretBox: SecretBox | undefined;
  github: GithubApiFactory;
  /** Drafts the issue. Without it, drafting answers 503; an issue can still be written by hand. */
  model: LanguageModel | undefined;
  clock: Clock;
  /** `publicUrl`: the webhook address shown to the admin is built from it. */
  config: Pick<
    ServerConfig,
    | "publicUrl"
    | "dailyTokenBudget"
    | "noticeDelaySeconds"
    | "issueRecheckSeconds"
    | "webhookSecretCacheMs"
  >;
}

const integrationPath = "/v1/integrations/github";

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

const notConfigured = json(
  errorSchema,
  "The server has no HELPOS_ENCRYPTION_KEY (`encryption_not_configured`), so no token can be stored or used",
);

const getRoute = apiRoute({
  // An admin may read it too: they connect and disconnect, so they must see what is there.
  access: { anyScope: ["github:write", "workspace:admin"] },
  method: "get",
  path: integrationPath,
  summary: "Read the workspace's GitHub connection",
  description:
    "Which repo is connected, and the webhook address to give GitHub. Never includes the " +
    "token or the webhook secret. Needs `github:write`, or `workspace:admin`.",
  responses: { 200: json(integrationSchema, "The connection") },
});

const connectRoute = apiRoute({
  // A token is a credential to the customer's code host: only a human admin stores one.
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  audit: { records: ["github.connected"] },
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
  request: {
    body: jsonBody(
      z.strictObject({
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
    ),
  },
  responses: {
    200: json(connectedSchema, "Connected"),
    422: json(
      errorSchema,
      "GitHub refused the token (`token_rejected`), or the token can't see the repo " +
        "(`repo_not_found`)",
    ),
    502: json(errorSchema, "GitHub could not be reached (`github_unavailable`)"),
    503: notConfigured,
  },
});

const disconnectRoute = apiRoute({
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  audit: { records: ["github.disconnected"] },
  method: "delete",
  path: integrationPath,
  summary: "Disconnect the GitHub repo",
  description:
    "Deletes the stored token and webhook secret. Tickets keep their issue links, and webhooks " +
    "are refused from now on. Needs `workspace:admin` in a human session.",
  responses: { 204: { description: "Disconnected, or nothing was connected" } },
});

const rotatePath = `${integrationPath}/webhook-secret`;
const rotateRoute = apiRoute({
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  audit: { records: ["github.webhook_secret_rotated"] },
  method: "post",
  path: rotatePath,
  summary: "Give the GitHub webhook a new secret",
  description:
    "Replaces the webhook secret, e.g. after it leaked, and returns the new one: this is the " +
    "only time it is shown. Paste it into the repo's webhook settings right away; until then " +
    "GitHub's deliveries are refused. The token is kept. Needs `workspace:admin` in a human " +
    "session.",
  responses: {
    200: json(
      z.object({ webhookSecret: z.string() }).openapi("GithubWebhookSecret"),
      "The new secret",
    ),
    404: json(errorSchema, "No repo is connected (`not_connected`)"),
    503: notConfigured,
  },
});

const draftIssueRoute = apiRoute({
  access: { allScopes: ["github:write", "tickets:read"] },
  audit: { records: ["github_issue.drafted"] },
  method: "post",
  path: "/v1/tickets/{id}/github-issue/draft",
  summary: "Ask the AI to draft a GitHub issue from a ticket",
  description:
    "Suggests a title and body (steps to reproduce, expected, actual) from the ticket's " +
    "messages. Nothing is created: edit the text, then create the issue. The customer's text " +
    "is data, never instructions, so the draft has no labels, assignees, links, @mentions or " +
    "issue references. Counts against the AI daily budget. Needs `tickets:read` and `github:write`.",
  request: { params: idParams },
  responses: {
    200: json(issueDraftSchema, "The suggested issue"),
    404: notFoundResponse,
    409: json(
      errorSchema,
      "No message from the customer to work from (`nothing_to_report`), or today's AI budget " +
        "is spent (`daily_budget_reached`)",
    ),
    502: json(errorSchema, "The AI provider failed (`ai_unavailable`)"),
    503: json(
      errorSchema,
      "AI is not configured on this server (`ai_not_configured`), or the workspace's other AI " +
        "calls in flight hold the rest of today's budget (`ai_busy`): try again in a minute",
    ),
  },
});

const createIssueRoute = apiRoute({
  // tickets:read too: the issue is made from the ticket, and the ticket's customer is who is
  // told when it is fixed, so a caller that cannot read the ticket cannot pick it either.
  access: { allScopes: ["github:write", "tickets:read"] },
  // A close found on linking writes the "fixed" notice draft too.
  audit: { records: ["github_issue.created", "github_issue.closed", "draft.created"] },
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
  request: {
    params: idParams,
    body: jsonBody(
      z.strictObject({
        title: z.string().trim().min(1).max(maxIssueTitleChars),
        body: z.string().max(60_000),
      }),
    ),
  },
  responses: {
    201: json(issueLinkSchema, "The issue, now linked to the ticket"),
    404: notFoundResponse,
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

export function registerGithubRoutes(app: OpenAPIHono, deps: GithubRoutesDeps): void {
  // Read by the webhook, forgotten here whenever the secret changes.
  const secrets = createWebhookSecrets({
    ...defaultWebhookSecretsOptions,
    maxAgeMs: deps.config.webhookSecretCacheMs,
  });
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
    const repo = await deps.db.withTenant(principal.tenantId, connectedRepo);
    return c.json(
      {
        connected: repo !== null,
        repo,
        webhookUrl: repo ? webhookUrl(deps.config.publicUrl, principal.tenantId) : null,
      },
      200,
    );
  });

  app.openapi(connectRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const audit = auditor(c);
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

    const connected = await deps.db.withTenant(tenantId, async (tx) => {
      const result = await connectIntegration(tx, box, {
        tenantId,
        repo,
        token: input.token,
        rotateWebhookSecret: input.rotateWebhookSecret ?? false,
      });
      await audit(tx, "github.connected", { type: "integration", id: result.id });
      return result;
    });
    secrets.forget(tenantId);
    // Never cached: when there is a new secret, the response is its only copy.
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        connected: true,
        repo: repoString(repo),
        webhookUrl: webhookUrl(deps.config.publicUrl, tenantId),
        webhookSecret: connected.webhookSecret,
      },
      200,
    );
  });

  app.openapi(rotateRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const audit = auditor(c);
    const box = deps.secretBox;
    if (!box) return c.json({ error: "encryption_not_configured" }, 503);
    const rotated = await deps.db.withTenant(tenantId, async (tx) => {
      const result = await rotateWebhookSecret(tx, box, tenantId);
      if (result)
        await audit(tx, "github.webhook_secret_rotated", { type: "integration", id: result.id });
      return result;
    });
    if (!rotated) return c.json({ error: "not_connected" }, 404);
    // The old secret stops working now, not once the webhook's copy of it expires.
    secrets.forget(tenantId);
    // Never cached: the response is the secret's only copy.
    c.header("Cache-Control", "no-store");
    return c.json({ webhookSecret: rotated.webhookSecret }, 200);
  });

  app.openapi(disconnectRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const audit = auditor(c);
    await deps.db.withTenant(tenantId, async (tx) => {
      const removed = await removeIntegration(tx);
      for (const id of removed) await audit(tx, "github.disconnected", { type: "integration", id });
      if (removed.length === 0) nothingToAudit("not connected");
    });
    secrets.forget(tenantId);
    return c.body(null, 204);
  });
}

function registerIssueRoutes(app: OpenAPIHono, deps: GithubRoutesDeps): void {
  app.openapi(draftIssueRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const model = deps.model;
    if (!model) return c.json({ error: "ai_not_configured" }, 503);
    const { id: ticketId } = c.req.valid("param");
    const outcome = await draftIssue({ ...deps, model }, { tenantId, ticketId, audit: auditor(c) });
    switch (outcome.kind) {
      case "not_found":
        return notFound(c);
      case "refused":
        return c.json({ error: outcome.error }, 409);
      case "ai_unavailable":
        return c.json({ error: "ai_unavailable" }, 502);
      case "ai_busy":
        return c.json({ error: "ai_busy" }, 503);
      case "drafted":
        return c.json({ title: outcome.title, body: outcome.body }, 200);
    }
  });

  app.openapi(createIssueRoute, async (c) => {
    const principal = c.get("principal");
    const secretBox = deps.secretBox;
    if (!secretBox) return c.json({ error: "encryption_not_configured" }, 503);
    const outcome = await createIssue(
      { ...deps, secretBox },
      {
        tenantId: principal.tenantId,
        ticketId: c.req.valid("param").id,
        issue: c.req.valid("json"),
        author: principal.actor.type === "agent" ? "agent" : "human",
        audit: auditor(c),
        requestId: c.get("requestId"),
      },
    );
    switch (outcome.kind) {
      case "not_found":
        return notFound(c);
      case "conflict":
        return c.json({ error: outcome.error }, 409);
      case "github_failed":
        return c.json({ error: outcome.error }, 502);
      case "not_linked":
        return c.json({ error: "issue_not_linked", url: outcome.url }, 500);
      case "created":
        return c.json(outcome.link, 201);
    }
  });
}
