import { randomBytes } from "node:crypto";
import { draftGithubIssue, type LanguageModel, maxIssueTitleChars } from "@helpos/ai";
import { and, asc, type Database, eq, isNull, lt, schema, sql } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { dailyBudget, lockUsage, recordUsage, totalTokens, utcDay } from "../ai-budget/budget.ts";
import { errorSummary } from "../app.ts";
import { recordAudit } from "../audit/audit.ts";
import { type Authenticate, requirePrincipal } from "../auth/principal.ts";
import { messageText } from "../drafts/html-text.ts";
import { type SecretBox, SecretBoxError } from "../secrets/secret-box.ts";
import { type GithubApiFactory, parseRepo, repoString } from "./github-api.ts";
import { registerGithubWebhook, webhookPath } from "./webhook.ts";

const { integrations, messages, ticketGithubIssues, tickets } = schema;

export interface GithubRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
  logger: Pick<Logger, "info" | "warn">;
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
}

/** A `creating` claim older than this belongs to a request that died; the next try takes over. */
const staleClaimSeconds = 120;

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
     * The webhook's secret. Shown only in this response: store it in GitHub's webhook settings
     * right away. Connecting again makes a new one.
     */
    webhookSecret: z.string(),
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
    "token or the webhook secret. Needs `github:write`.",
  security,
  responses: { 200: json(integrationSchema, "The connection"), ...authErrors },
});

const connectRoute = createRoute({
  method: "put",
  path: integrationPath,
  summary: "Connect a GitHub repo",
  description:
    "Stores one repo and a fine-grained personal access token with Issues read and write " +
    "access to it, replacing any earlier connection. The token is checked with GitHub first, " +
    "then stored encrypted; it is never returned. The response holds a new webhook secret, the " +
    "only time it is shown. Needs `workspace:admin` in a human session.",
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
              .regex(/^(github_pat_|ghp_)[A-Za-z0-9_]{20,250}$/, "must be a GitHub token"),
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
    "the ticket. Only title and body are sent: no labels, assignees or milestones. When the " +
    "issue is closed as completed, the ticket gets a `fixed` draft to approve. One issue per " +
    "ticket. Needs `github:write`.",
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
        "(`already_linked`), or the stored token can't be read with the server's key and the " +
        "repo must be connected again (`reconnect_required`)",
    ),
    502: json(
      errorSchema,
      "GitHub refused the token (`token_rejected`), can't see the repo (`repo_not_found`), " +
        "or could not be reached (`github_unavailable`). Nothing was linked",
    ),
    503: notConfigured,
  },
});

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
  app.use("/v1/tickets/*", auth);

  registerConnectionRoutes(app, deps);
  registerIssueRoutes(app, deps);
  registerGithubWebhook(app, deps);
}

function registerConnectionRoutes(app: OpenAPIHono, deps: GithubRoutesDeps): void {
  app.openapi(getRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("github:write")) return c.json({ error: "forbidden" }, 403);
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
    const webhookSecret = randomBytes(32).toString("hex");
    const sealed = {
      tokenCiphertext: box.seal(input.token, { tenantId, purpose: "github-token" }),
      webhookSecretCiphertext: box.seal(webhookSecret, {
        tenantId,
        purpose: "github-webhook-secret",
      }),
    };
    await deps.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .insert(integrations)
        .values({ tenantId, provider: "github", repo: repoString(repo), ...sealed })
        .onConflictDoUpdate({
          target: [integrations.tenantId, integrations.provider],
          set: { repo: repoString(repo), ...sealed, updatedAt: new Date() },
        })
        .returning({ id: integrations.id });
      if (!row) throw new Error("github connect: upsert returned no row");
      await recordAudit(tx, {
        tenantId,
        actor: principal.actor,
        action: "github.connected",
        target: { type: "integration", id: row.id },
        requestId: c.get("requestId"),
      });
    });
    // Never cached: the response is the only copy of the webhook secret.
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

    const result = await deps.db.withTenant(tenantId, async (tx) => {
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

      // Locked across the model call, like reply drafting, so two calls can't both slip
      // under the cap.
      const used = await lockUsage(tx, tenantId, day);
      if (totalTokens(used) >= (await dailyBudget(tx, tenantId, deps.dailyTokenBudget))) {
        return "daily_budget_reached" as const;
      }
      let draft: Awaited<ReturnType<typeof draftGithubIssue>>;
      try {
        draft = await draftGithubIssue(model, {
          from: latest.from,
          subject: ticket.subject,
          body: messageText(latest),
          history: rows.slice(0, lastInbound).map((m) => ({
            direction: m.direction,
            from: m.from,
            body: messageText(m),
          })),
        });
      } catch (error) {
        deps.logger.warn({ err: errorSummary(error) }, "github issue draft: AI call failed");
        return "ai_unavailable" as const;
      }
      await recordUsage(tx, tenantId, day, draft.usage);
      await recordAudit(tx, {
        tenantId,
        actor: principal.actor,
        action: "github_issue.drafted",
        target: { type: "ticket", id },
        requestId: c.get("requestId"),
      });
      return { title: draft.title, body: draft.body };
    });

    if (result === "not_found") return c.json({ error: result }, 404);
    if (result === "nothing_to_report" || result === "daily_budget_reached") {
      return c.json({ error: result }, 409);
    }
    if (result === "ai_unavailable") return c.json({ error: result }, 502);
    return c.json(result, 200);
  });

  app.openapi(createIssueRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("github:write")) return c.json({ error: "forbidden" }, 403);
    const box = deps.secretBox;
    if (!box) return c.json({ error: "encryption_not_configured" }, 503);
    const { id: ticketId } = c.req.valid("param");
    const issue = c.req.valid("json");
    const { tenantId } = principal;

    // 1. Claim the ticket's issue slot, so a double click can't open two issues.
    const claim = await deps.db.withTenant(tenantId, async (tx) => {
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
      // A claim left by a request that died never blocks the ticket for good.
      await tx
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
        );
      const [claimed] = await tx
        .insert(ticketGithubIssues)
        .values({ tenantId, ticketId, repo: integration.repo, state: "creating" })
        .onConflictDoNothing({ target: [ticketGithubIssues.tenantId, ticketGithubIssues.ticketId] })
        .returning({ id: ticketGithubIssues.id });
      if (!claimed) return "already_linked" as const;
      return { claimId: claimed.id, repo: integration.repo, token };
    });
    if (claim === "not_found") return c.json({ error: claim }, 404);
    if (typeof claim === "string") return c.json({ error: claim }, 409);

    // 2. Call GitHub with no transaction open: a slow GitHub holds no connection or lock.
    const repo = parseRepo(claim.repo);
    if (!repo) throw new Error("github issue: stored repo is not owner/name");
    const created = await deps.github(claim.token).createIssue(repo, issue);
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

    // 3. Record the issue on the claim, with its audit event.
    const link = await deps.db.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .update(ticketGithubIssues)
        .set({
          state: "open",
          issueNumber: created.value.number,
          issueUrl: created.value.url,
        })
        .where(
          and(eq(ticketGithubIssues.id, claim.claimId), eq(ticketGithubIssues.state, "creating")),
        )
        .returning();
      // Only if this request was so slow that another took its claim over.
      if (!row) throw new Error("github issue: claim was taken over while GitHub was called");
      await recordAudit(tx, {
        tenantId,
        actor: principal.actor,
        action: "github_issue.created",
        target: { type: "ticket", id: ticketId },
        requestId: c.get("requestId"),
      });
      return row;
    });
    deps.logger.info({ ticketId, issue: created.value.number }, "github issue created");
    return c.json(
      {
        repo: link.repo,
        number: created.value.number,
        url: created.value.url,
        state: "open" as const,
      },
      201,
    );
  });
}
