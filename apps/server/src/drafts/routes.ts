import { quotesInternalPassage } from "@helpos/ai";
import { asc, type Database, eq, inArray, schema, type TenantTx } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { aiBudget } from "../ai-budget/budget.ts";
import { nothingToAudit } from "../audit/audit.ts";
import { apiRoute, Grant } from "../auth/access.ts";
import type { Principal } from "../auth/principal.ts";
import {
  auditContext,
  errorSchema,
  idParams,
  json,
  jsonBody,
  notFound,
  notFoundResponse,
} from "../http/route-kit.ts";
import type { Clock, ServerConfig } from "../services.ts";
import {
  approveDraft,
  createReply,
  type DraftRow,
  discardDraft,
  editDraft,
  isPendingDraft,
  liveDraftFor,
  lockConversationForDrafting,
  regenerateDraft,
  resolveUncertainSend,
  retrySend,
} from "./lifecycle.ts";

const { draftCitations, drafts, conversations } = schema;

export interface DraftRoutesDeps {
  db: Pick<Database, "withTenant">;
  clock: Clock;
  /** Regenerate is refused up front when today's AI budget (`dailyTokenBudget`) is spent. */
  config: Pick<ServerConfig, "dailyTokenBudget" | "noticeDelaySeconds">;
  logger: Pick<Logger, "warn">;
}

const draftSourceSchema = z
  .object({
    /** Null when the source has since been deleted; the rest is what the draft saw. */
    sourceId: z.uuid().nullable(),
    title: z.string(),
    url: z.string().nullable(),
    /**
     * `internal` sources are the team's notes: the draft may follow them, so check it doesn't
     * reveal them before approving.
     */
    visibility: z.enum(schema.knowledgeVisibilities),
    /** The passage the model was given. */
    excerpt: z.string(),
    /** True when the model says it used this passage; false when it was offered but unused. */
    cited: z.boolean(),
  })
  .openapi("DraftSource");
const draftSchema = z
  .object({
    id: z.uuid(),
    conversationId: z.uuid(),
    /** The inbound message this draft answers. */
    messageId: z.uuid(),
    /**
     * `reply` answers the customer. `fixed` tells them the GitHub issue made from their conversation
     * is closed as done; it is written when GitHub says so, and approved like any reply.
     */
    kind: z.enum(schema.draftKinds),
    status: z.enum(schema.draftStatuses),
    outboundMessageId: z.string().nullable(),
    body: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().nullable(),
    sentAt: z.iso.datetime().nullable(),
    /**
     * Knowledge passages the draft was written with, best match first. Always empty for a
     * caller without `knowledge:read`.
     */
    sources: z.array(draftSourceSchema),
    /**
     * True when the model was shown one of the team's internal notes while writing the draft.
     * For every caller, even without `knowledge:read`: whoever approves the draft should check
     * it doesn't reveal the note.
     */
    internalKnowledge: z.boolean(),
    /**
     * True when the body repeats one of those internal notes word for word (a long run, not a
     * stock phrase). Checked against the current body, so it clears once the quote is edited
     * out. A strong hint the draft leaks the note: read it closely before approving. Always
     * false for a caller without `knowledge:read`, who still gets `internalKnowledge`.
     */
    quotesInternalNote: z.boolean(),
  })
  .openapi("Draft");
type DraftJson = z.infer<typeof draftSchema>;
type DraftSourceJson = z.infer<typeof draftSourceSchema>;

const listRoute = apiRoute({
  access: { allScopes: ["conversations:read"] },
  method: "get",
  path: "/v1/conversations/{id}/drafts",
  summary: "List a conversation's drafts",
  description: "Every AI draft on the conversation, oldest first. Needs `conversations:read`.",
  request: { params: idParams },
  responses: {
    200: json(z.object({ drafts: z.array(draftSchema) }), "The drafts"),
    404: notFoundResponse,
  },
});

const editRoute = apiRoute({
  access: { allScopes: ["drafts:write"] },
  audit: { records: ["draft.edited"] },
  method: "patch",
  path: "/v1/drafts/{id}",
  summary: "Edit a pending draft",
  description: "Replaces the body of a draft that is still `pending`. Needs `drafts:write`.",
  request: {
    params: idParams,
    body: jsonBody(z.strictObject({ body: z.string().trim().min(1).max(50_000) })),
  },
  responses: {
    200: json(draftSchema, "The edited draft"),
    404: notFoundResponse,
    409: json(errorSchema, "The draft is no longer pending"),
  },
});

const approveRoute = apiRoute({
  access: { allScopes: ["drafts:approve"] },
  audit: { records: ["draft.approved"] },
  method: "post",
  path: "/v1/drafts/{id}/approve",
  summary: "Approve a draft and send it",
  description:
    "Marks a `pending` draft `approved` and queues it to be sent, in one transaction. This is " +
    "the only way a reply reaches a customer. Sending happens in the background: the draft " +
    "becomes `sent` once the email is out, and a failed send is retried. The request carries " +
    "the body the approver reviewed: if the draft was edited since, nothing is approved (409). " +
    "Needs `drafts:approve`.",
  request: {
    params: idParams,
    body: jsonBody(z.strictObject({ body: z.string() })),
  },
  responses: {
    200: json(draftSchema, "The approved draft"),
    404: notFoundResponse,
    409: json(errorSchema, "The draft is no longer pending, or was edited since it was reviewed"),
  },
});

const discardRoute = apiRoute({
  access: { allScopes: ["drafts:write"] },
  audit: { records: ["draft.discarded"] },
  method: "post",
  path: "/v1/drafts/{id}/discard",
  summary: "Discard a pending or failed draft",
  description:
    "Marks a `pending` or `send_failed` draft `discarded`, so it can never be approved or " +
    "sent. Use it for a draft that shouldn't go out. Needs `drafts:write`.",
  request: { params: idParams },
  responses: {
    200: json(draftSchema, "The discarded draft"),
    404: notFoundResponse,
    409: json(errorSchema, "The draft is not pending or `send_failed`"),
  },
});

const retryRoute = apiRoute({
  access: { allScopes: ["drafts:approve"] },
  audit: { records: ["draft.send_retried"] },
  method: "post",
  path: "/v1/drafts/{id}/retry",
  summary: "Retry sending a failed draft",
  description:
    "Queues a `send_failed` draft to be sent again and marks it `approved`, in one " +
    "transaction. It goes out with the same Message-ID as the failed attempts, the same text, " +
    "and to whoever shadow mode says at the time it is sent. Safe to repeat: a `sent` draft is " +
    "returned as it is, and an `approved` one has its send queued again only if none is " +
    "queued already, so it is never sent twice. Needs `drafts:approve`.",
  request: { params: idParams },
  responses: {
    200: json(draftSchema, "The draft, queued to send (or already sending or sent)"),
    404: notFoundResponse,
    409: json(errorSchema, "The draft was never approved, or was discarded"),
  },
});

const createDraftRoute = apiRoute({
  // conversations:read too: the draft answers the conversation, so it shows what the customer wrote.
  access: { allScopes: ["drafts:write", "conversations:read"] },
  audit: { records: ["draft.created", "draft.discarded"] },
  method: "post",
  path: "/v1/conversations/{id}/drafts",
  summary: "Write a draft, or ask the AI for a new one",
  description:
    "Answers the conversation's latest customer message. With `body`, saves that text as a " +
    "`pending` draft (201). With `regenerate: true`, queues a fresh AI draft (202): it " +
    "appears in the list when ready. Either way, older pending replies on the conversation are " +
    "discarded (a pending `fixed` notice is kept). Nothing is sent until the draft is " +
    "approved. Needs `drafts:write` and `conversations:read`.",
  request: {
    params: idParams,
    body: jsonBody(
      z.union([
        z.strictObject({ body: z.string().trim().min(1).max(50_000) }),
        z.strictObject({ regenerate: z.literal(true) }),
      ]),
    ),
  },
  responses: {
    201: json(draftSchema, "The new draft"),
    202: json(z.object({ status: z.literal("queued") }), "An AI draft is being written"),
    404: notFoundResponse,
    409: json(
      errorSchema,
      "No customer message to answer (`nothing_to_answer`), or the latest one already has " +
        "an approved or sent reply (`already_answered`), or `regenerate` was asked after " +
        "today's AI budget was spent (`daily_budget_reached`) or on a closed conversation " +
        "(`conversation_closed`)",
    ),
  },
});

/**
 * What a draft shows about the knowledge it was written from. Only a caller with
 * `knowledge:read` may see it, so building one needs that grant.
 */
interface DraftKnowledge {
  grant: Grant<"knowledge:read">;
  sources: DraftSourceJson[];
  /**
   * Whether the body quotes an internal note. With the flag alone, someone who can edit
   * drafts could guess text, save it, and watch the flag to piece the note together.
   */
  quotesInternalNote: boolean;
}

function serialize(
  d: DraftRow,
  internalKnowledge: boolean,
  knowledge: DraftKnowledge | null,
): DraftJson {
  return {
    id: d.id,
    conversationId: d.conversationId,
    messageId: d.messageId,
    kind: d.kind,
    status: d.status,
    outboundMessageId: d.outboundMessageIdHeader,
    body: d.body,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    approvedAt: d.approvedAt?.toISOString() ?? null,
    sentAt: d.sentAt?.toISOString() ?? null,
    sources: knowledge?.sources ?? [],
    internalKnowledge,
    quotesInternalNote: knowledge?.quotesInternalNote ?? false,
  };
}

/**
 * The drafts as the API shows them to `principal`. Their knowledge sources only with
 * `knowledge:read`: titles, links and passages of internal notes are knowledge, and reading
 * drafts must not be a way around that scope.
 */
async function present(tx: TenantTx, principal: Principal, rows: DraftRow[]): Promise<DraftJson[]> {
  if (rows.length === 0) return [];
  const grant = Grant.check(principal, "knowledge:read");
  // Every passage the model was shown, cited or not (the `cited` column tells them apart).
  const shown = await tx
    .select({
      draftId: draftCitations.draftId,
      sourceId: draftCitations.sourceId,
      title: draftCitations.title,
      url: draftCitations.url,
      visibility: draftCitations.visibility,
      excerpt: draftCitations.excerpt,
      cited: draftCitations.cited,
    })
    .from(draftCitations)
    .where(
      inArray(
        draftCitations.draftId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(draftCitations.rank));
  return rows.map((row) => {
    const seen = shown.filter((c) => c.draftId === row.id);
    // Uncited notes count too: a model that pastes a note may well leave it off its sources line.
    const internal = seen.filter((c) => c.visibility === "internal").map((c) => c.excerpt);
    return serialize(
      row,
      internal.length > 0,
      grant && {
        grant,
        sources: seen.map(({ draftId: _, ...source }) => source),
        quotesInternalNote: quotesInternalPassage(row.body, internal),
      },
    );
  });
}

async function presentOne(tx: TenantTx, principal: Principal, row: DraftRow): Promise<DraftJson> {
  const [json] = await present(tx, principal, [row]);
  if (!json) throw new Error("present draft: no result");
  return json;
}

export function registerDraftRoutes(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(listRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [conversation] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, id));
      if (!conversation) return null;
      const rows = await tx
        .select()
        .from(drafts)
        .where(eq(drafts.conversationId, id))
        .orderBy(asc(drafts.createdAt));
      return present(tx, principal, rows);
    });
    // Another workspace's conversation looks exactly like one that doesn't exist.
    if (!result) return notFound(c);
    return c.json({ drafts: result }, 200);
  });

  app.openapi(editRoute, async (c) => {
    const principal = c.get("principal");
    const context = auditContext(c);
    const { id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const edited = await editDraft(tx, context, id, body);
      if (edited.outcome !== "changed") return edited.outcome;
      return presentOne(tx, principal, edited.draft);
    });
    if (result === "not_found") return notFound(c);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(result, 200);
  });

  app.openapi(approveRoute, async (c) => {
    const principal = c.get("principal");
    const context = auditContext(c);
    const { id } = c.req.valid("param");
    const { body: reviewed } = c.req.valid("json");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const approved = await approveDraft(tx, context, id, reviewed);
      if (approved.outcome !== "changed") return approved.outcome;
      return presentOne(tx, principal, approved.draft);
    });
    if (result === "not_found") return notFound(c);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(result, 200);
  });

  registerResolveRoute(app, deps);
  registerDiscardRoute(app, deps);
  registerRetryRoute(app, deps);
  registerCreateRoute(app, deps);
}

function registerCreateRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  const budget = aiBudget(deps);
  app.openapi(createDraftRoute, async (c) => {
    const principal = c.get("principal");
    const { id: conversationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const { tenantId } = principal;
    const context = auditContext(c);

    const result = await deps.db.withTenant(tenantId, async (tx) => {
      if ("regenerate" in input) {
        const regenerated = await regenerateDraft(tx, context, conversationId, budget);
        if (regenerated.outcome === "queued" && regenerated.discardedDraftIds.length === 0) {
          nothingToAudit("queued; the worker audits the draft");
        }
        return regenerated.outcome;
      }
      const lock = await lockConversationForDrafting(tx, conversationId);
      if (!lock) return "not_found" as const;
      const messageId = lock.answering;
      if (!messageId) return "nothing_to_answer" as const;
      const live = await liveDraftFor(tx, messageId, "reply");
      if (live && !isPendingDraft(live)) return "already_answered" as const;

      const draft = await createReply(tx, context, {
        tenantId,
        conversationId,
        messageId,
        body: input.body,
        noticeDelaySeconds: deps.config.noticeDelaySeconds,
      });
      return presentOne(tx, principal, draft);
    });

    if (result === "not_found") return notFound(c);
    if (
      result === "nothing_to_answer" ||
      result === "already_answered" ||
      result === "daily_budget_reached" ||
      result === "conversation_closed"
    ) {
      return c.json({ error: result }, 409);
    }
    if (result === "queued") return c.json({ status: "queued" as const }, 202);
    return c.json(result, 201);
  });
}

function registerDiscardRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(discardRoute, async (c) => {
    const principal = c.get("principal");
    const context = auditContext(c);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const discarded = await discardDraft(tx, context, id);
      if (discarded.outcome !== "changed") return discarded.outcome;
      return presentOne(tx, principal, discarded.draft);
    });
    if (result === "not_found") return notFound(c);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(result, 200);
  });
}

function registerRetryRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(retryRoute, async (c) => {
    const principal = c.get("principal");
    const context = auditContext(c);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const retried = await retrySend(tx, context, id);
      if (retried.outcome === "not_found" || retried.outcome === "conflict") {
        return retried.outcome;
      }
      if (retried.outcome === "already_sent") nothingToAudit("already sent");
      return presentOne(tx, principal, retried.draft);
    });
    if (result === "not_found") return notFound(c);
    if (result === "conflict") return c.json({ error: "not_send_failed" }, 409);
    return c.json(result, 200);
  });
}

const resolveRoute = apiRoute({
  access: { allScopes: ["drafts:approve"], humansOnly: true },
  audit: { records: ["draft.send_confirmed", "draft.send_retried"] },
  method: "post",
  path: "/v1/drafts/{id}/resolve-send",
  summary: "Resolve an uncertain send",
  description:
    "Human decision for a reply that may already have gone out. Mark it sent or explicitly send again. The Message-ID binds the decision to the attempt reviewed.",
  request: {
    params: idParams,
    body: jsonBody(
      z.strictObject({
        messageId: z.string().min(1),
        decision: z.enum(["mark_sent", "send_again"]),
      }),
    ),
  },
  responses: {
    200: json(draftSchema, "The resolved draft"),
    404: notFoundResponse,
    409: json(errorSchema, "This uncertain attempt is no longer current"),
  },
});

function registerResolveRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(resolveRoute, async (c) => {
    const principal = c.get("principal");
    const context = auditContext(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const resolved = await resolveUncertainSend(tx, context, id, input);
      if (resolved.outcome !== "changed") return resolved.outcome;
      return presentOne(tx, principal, resolved.draft);
    });
    if (result === "not_found") return notFound(c);
    if (result === "conflict") return c.json({ error: "not_current_uncertain_send" }, 409);
    return c.json(result, 200);
  });
}
