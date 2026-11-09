import { quotesInternalPassage } from "@helpos/ai";
import {
  and,
  asc,
  type Database,
  desc,
  enqueue,
  eq,
  inArray,
  isNull,
  ne,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { dailyBudget, totalTokens, usageOn, utcDay } from "../ai-budget/budget.ts";
import { recordAudit } from "../audit/audit.ts";
import { apiRoute } from "../auth/access.ts";
import { type Authenticate, type Principal, requirePrincipal } from "../auth/principal.ts";
import { draftReplyJob, sendReplyJob } from "./jobs.ts";
import { queueDraftNotice } from "./notice-worker.ts";

const { draftCitations, drafts, mailboxes, messages, tickets } = schema;
type DraftRow = typeof drafts.$inferSelect;

export interface DraftRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
  /** Regenerate is refused up front when today's AI budget is spent. */
  dailyTokenBudget: number;
  now?: () => Date;
  /** How long a new draft waits before its owner notice is sent. */
  noticeDelaySeconds?: number;
}

const errorSchema = z.object({ error: z.string() }).openapi("Error");
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
    ticketId: z.uuid(),
    /** The inbound message this draft answers. */
    messageId: z.uuid(),
    /**
     * `reply` answers the customer. `fixed` tells them the GitHub issue made from their ticket
     * is closed as done; it is written when GitHub says so, and approved like any reply.
     */
    kind: z.enum(schema.draftKinds),
    status: z.enum(schema.draftStatuses),
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

const idParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const authErrors = {
  401: json(errorSchema, "No valid credentials"),
  403: json(errorSchema, "The credentials lack the required scope"),
  404: json(errorSchema, "Not found in this workspace"),
} as const;
const security = [{ apiAuth: [] }];

const listRoute = apiRoute({
  access: { allScopes: ["tickets:read"] },
  method: "get",
  path: "/v1/tickets/{id}/drafts",
  summary: "List a ticket's drafts",
  description: "Every AI draft on the ticket, oldest first. Needs `tickets:read`.",
  security,
  request: { params: idParams },
  responses: {
    200: json(z.object({ drafts: z.array(draftSchema) }), "The drafts"),
    ...authErrors,
  },
});

const editRoute = apiRoute({
  access: { allScopes: ["drafts:write"] },
  method: "patch",
  path: "/v1/drafts/{id}",
  summary: "Edit a pending draft",
  description: "Replaces the body of a draft that is still `pending`. Needs `drafts:write`.",
  security,
  request: {
    params: idParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({ body: z.string().trim().min(1).max(50_000) }),
        },
      },
    },
  },
  responses: {
    200: json(draftSchema, "The edited draft"),
    ...authErrors,
    409: json(errorSchema, "The draft is no longer pending"),
  },
});

const approveRoute = apiRoute({
  access: { allScopes: ["drafts:approve"] },
  method: "post",
  path: "/v1/drafts/{id}/approve",
  summary: "Approve a draft and send it",
  description:
    "Marks a `pending` draft `approved` and queues it to be sent, in one transaction. This is " +
    "the only way a reply reaches a customer. Sending happens in the background: the draft " +
    "becomes `sent` once the email is out, and a failed send is retried. The request carries " +
    "the body the approver reviewed: if the draft was edited since, nothing is approved (409). " +
    "Needs `drafts:approve`.",
  security,
  request: {
    params: idParams,
    body: {
      required: true,
      content: { "application/json": { schema: z.strictObject({ body: z.string() }) } },
    },
  },
  responses: {
    200: json(draftSchema, "The approved draft"),
    ...authErrors,
    409: json(errorSchema, "The draft is no longer pending, or was edited since it was reviewed"),
  },
});

const discardRoute = apiRoute({
  access: { allScopes: ["drafts:write"] },
  method: "post",
  path: "/v1/drafts/{id}/discard",
  summary: "Discard a pending or failed draft",
  description:
    "Marks a `pending` or `send_failed` draft `discarded`, so it can never be approved or " +
    "sent. Use it for a draft that shouldn't go out. Needs `drafts:write`.",
  security,
  request: { params: idParams },
  responses: {
    200: json(draftSchema, "The discarded draft"),
    ...authErrors,
    409: json(errorSchema, "The draft is not pending or `send_failed`"),
  },
});

const retryRoute = apiRoute({
  access: { allScopes: ["drafts:approve"] },
  method: "post",
  path: "/v1/drafts/{id}/retry",
  summary: "Retry sending a failed draft",
  description:
    "Queues a `send_failed` draft to be sent again and marks it `approved`, in one " +
    "transaction. It goes out with the same Message-ID as the failed attempts, the same text, " +
    "and to whoever shadow mode says at the time it is sent. Safe to repeat: a `sent` draft is " +
    "returned as it is, and an `approved` one has its send queued again only if none is " +
    "queued already, so it is never sent twice. Needs `drafts:approve`.",
  security,
  request: { params: idParams },
  responses: {
    200: json(draftSchema, "The draft, queued to send (or already sending or sent)"),
    ...authErrors,
    409: json(errorSchema, "The draft was never approved, or was discarded"),
  },
});

const createRoute_ = apiRoute({
  access: { allScopes: ["drafts:write"] },
  method: "post",
  path: "/v1/tickets/{id}/drafts",
  summary: "Write a draft, or ask the AI for a new one",
  description:
    "Answers the ticket's latest customer message. With `body`, saves that text as a " +
    "`pending` draft (201). With `regenerate: true`, queues a fresh AI draft (202): it " +
    "appears in the list when ready. Either way, older pending replies on the ticket are " +
    "discarded (a pending `fixed` notice is kept). Nothing is sent until the draft is " +
    "approved. Needs `drafts:write`.",
  security,
  request: {
    params: idParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.union([
            z.strictObject({ body: z.string().trim().min(1).max(50_000) }),
            z.strictObject({ regenerate: z.literal(true) }),
          ]),
        },
      },
    },
  },
  responses: {
    201: json(draftSchema, "The new draft"),
    202: json(z.object({ status: z.literal("queued") }), "An AI draft is being written"),
    ...authErrors,
    409: json(
      errorSchema,
      "No customer message to answer (`nothing_to_answer`), or the latest one already has " +
        "an approved or sent reply (`already_answered`), or `regenerate` was asked after " +
        "today's AI budget was spent (`daily_budget_reached`)",
    ),
  },
});

function serialize(
  d: DraftRow,
  sources: DraftSourceJson[],
  internalKnowledge: boolean,
  quotesInternalNote: boolean,
): DraftJson {
  return {
    id: d.id,
    ticketId: d.ticketId,
    messageId: d.messageId,
    kind: d.kind,
    status: d.status,
    body: d.body,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    approvedAt: d.approvedAt?.toISOString() ?? null,
    sentAt: d.sentAt?.toISOString() ?? null,
    sources,
    internalKnowledge,
    quotesInternalNote,
  };
}

/**
 * The drafts as the API shows them to `principal`. Their knowledge sources only with
 * `knowledge:read`: titles, links and passages of internal notes are knowledge, and reading
 * drafts must not be a way around that scope.
 */
async function present(tx: TenantTx, principal: Principal, rows: DraftRow[]): Promise<DraftJson[]> {
  if (rows.length === 0) return [];
  const canRead = principal.scopes.has("knowledge:read");
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
      canRead ? seen.map(({ draftId: _, ...source }) => source) : [],
      internal.length > 0,
      // Only with knowledge:read: otherwise someone who can edit drafts could guess text, save
      // it, and watch the flag to piece the note together.
      canRead && quotesInternalPassage(row.body, internal),
    );
  });
}

async function presentOne(tx: TenantTx, principal: Principal, row: DraftRow): Promise<DraftJson> {
  const [json] = await present(tx, principal, [row]);
  if (!json) throw new Error("present draft: no result");
  return json;
}

export function registerDraftRoutes(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  const auth = requirePrincipal(deps.authenticate);
  app.use("/v1/tickets/*", auth);
  app.use("/v1/drafts/*", auth);

  app.openapi(listRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [ticket] = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
      if (!ticket) return null;
      const rows = await tx
        .select()
        .from(drafts)
        .where(eq(drafts.ticketId, id))
        .orderBy(asc(drafts.createdAt));
      return present(tx, principal, rows);
    });
    // Another workspace's ticket looks exactly like one that doesn't exist.
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json({ drafts: result }, 200);
  });

  app.openapi(editRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      // Conditional on `pending`, so an edit can never change a draft already approved.
      const [updated] = await tx
        .update(drafts)
        .set({ body })
        .where(and(eq(drafts.id, id), eq(drafts.status, "pending")))
        .returning();
      if (!updated) return (await draftExists(tx, id)) ? "conflict" : "not_found";
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "draft.edited",
        target: { type: "draft", id },
        requestId: c.get("requestId"),
      });
      return presentOne(tx, principal, updated);
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(result, 200);
  });

  app.openapi(approveRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const { body: reviewed } = c.req.valid("json");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [found] = await tx
        .select({ mailbox: mailboxes.address })
        .from(drafts)
        .innerJoin(tickets, eq(tickets.id, drafts.ticketId))
        .innerJoin(mailboxes, eq(mailboxes.id, tickets.mailboxId))
        .where(eq(drafts.id, id));
      if (!found) return "not_found";
      const domain = found.mailbox.split("@").pop() ?? "localhost";

      // Approval, audit event and send job commit together, or none of them do.
      const [approved] = await tx
        .update(drafts)
        .set({
          status: "approved",
          // The database clock, like the audit events the notice window compares it with.
          approvedAt: sql`now()`,
          outboundMessageIdHeader: `<${uuidv7()}@${domain}>`,
        })
        // Bound to the exact text reviewed: an edit made after review can't ride on the approval.
        .where(and(eq(drafts.id, id), eq(drafts.status, "pending"), eq(drafts.body, reviewed)))
        .returning();
      if (!approved) return "conflict";
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "draft.approved",
        target: { type: "draft", id },
        requestId: c.get("requestId"),
      });
      await enqueue(
        tx,
        sendReplyJob,
        { tenantId: principal.tenantId, draftId: id },
        { singletonKey: id },
      );
      return presentOne(tx, principal, approved);
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(result, 200);
  });

  registerDiscardRoute(app, deps);
  registerRetryRoute(app, deps);
  registerCreateRoute(app, deps);
}

function registerCreateRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(createRoute_, async (c) => {
    const principal = c.get("principal");
    const { id: ticketId } = c.req.valid("param");
    const input = c.req.valid("json");
    const { tenantId, actor } = principal;
    const requestId = c.get("requestId");

    const result = await deps.db.withTenant(tenantId, async (tx) => {
      const [ticket] = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        // Serialises drafting on this ticket, so two calls can't both create a live draft.
        .for("update");
      if (!ticket) return "not_found" as const;

      // The latest message from a person. Machine mail is never answered.
      const [latest] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.ticketId, ticketId),
            eq(messages.direction, "inbound"),
            isNull(messages.automatedReason),
          ),
        )
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(1);
      if (!latest) return "nothing_to_answer" as const;

      const [answered] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(
          and(
            eq(drafts.messageId, latest.id),
            eq(drafts.kind, "reply"),
            ne(drafts.status, "discarded"),
            ne(drafts.status, "pending"),
          ),
        );
      if (answered) return "already_answered" as const;

      // Checked before anything is discarded: a refused regenerate leaves the current draft
      // alone, and the caller hears why instead of waiting for a draft that never comes.
      if ("regenerate" in input) {
        const used = await usageOn(tx, utcDay((deps.now ?? (() => new Date()))()));
        if (totalTokens(used) >= (await dailyBudget(tx, tenantId, deps.dailyTokenBudget)))
          return "daily_budget_reached" as const;
      }

      const stale = await tx
        .update(drafts)
        .set({ status: "discarded" })
        .where(
          and(
            eq(drafts.ticketId, ticketId),
            eq(drafts.status, "pending"),
            // Only replies: a pending "fixed" notice isn't replaced by a new reply.
            eq(drafts.kind, "reply"),
          ),
        )
        .returning({ id: drafts.id });
      for (const { id } of stale) {
        await recordAudit(tx, {
          tenantId,
          actor,
          action: "draft.discarded",
          target: { type: "draft", id },
          requestId,
        });
      }

      if ("regenerate" in input) {
        await enqueue(
          tx,
          draftReplyJob,
          { tenantId, messageId: latest.id },
          { singletonKey: latest.id },
        );
        return "queued" as const;
      }
      const [draft] = await tx
        .insert(drafts)
        .values({ tenantId, ticketId, messageId: latest.id, body: input.body })
        .returning();
      if (!draft) throw new Error("create draft: insert returned no row");
      await queueDraftNotice(tx, draft, deps.noticeDelaySeconds);
      // The ticket has an answer now, so it's no longer waiting on a paused AI.
      await tx.update(tickets).set({ aiPausedReason: null }).where(eq(tickets.id, ticketId));
      await recordAudit(tx, {
        tenantId,
        actor,
        action: "draft.created",
        target: { type: "draft", id: draft.id },
        requestId,
      });
      return presentOne(tx, principal, draft);
    });

    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (
      result === "nothing_to_answer" ||
      result === "already_answered" ||
      result === "daily_budget_reached"
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
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [discarded] = await tx
        .update(drafts)
        .set({ status: "discarded" })
        .where(and(eq(drafts.id, id), inArray(drafts.status, ["pending", "send_failed"])))
        .returning();
      if (!discarded) return (await draftExists(tx, id)) ? "conflict" : "not_found";
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "draft.discarded",
        target: { type: "draft", id },
        requestId: c.get("requestId"),
      });
      return presentOne(tx, principal, discarded);
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(result, 200);
  });
}

function registerRetryRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(retryRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      // Conditional on `send_failed`, so two retries at once queue one send between them. The
      // Message-ID fixed at approval is kept: a server that got an earlier attempt drops this one.
      const [retried] = await tx
        .update(drafts)
        .set({ status: "approved" })
        .where(and(eq(drafts.id, id), eq(drafts.status, "send_failed")))
        .returning();
      if (!retried) {
        const [current] = await tx.select().from(drafts).where(eq(drafts.id, id));
        if (!current) return "not_found" as const;
        if (current.status === "sent") return presentOne(tx, principal, current);
        if (current.status !== "approved") return "conflict" as const;
        // Already approved: queue the send again in case its job was lost (it expired, or the
        // worker died, on the last attempt). The singleton key returns the live job if there
        // is one, and the worker locks the draft and skips it once sent, so it can't go twice.
        await recordAudit(tx, {
          tenantId: principal.tenantId,
          actor: principal.actor,
          action: "draft.send_retried",
          target: { type: "draft", id },
          requestId: c.get("requestId"),
        });
        await enqueue(
          tx,
          sendReplyJob,
          { tenantId: principal.tenantId, draftId: id },
          { singletonKey: id },
        );
        return presentOne(tx, principal, current);
      }
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "draft.send_retried",
        target: { type: "draft", id },
        requestId: c.get("requestId"),
      });
      await enqueue(
        tx,
        sendReplyJob,
        { tenantId: principal.tenantId, draftId: id },
        { singletonKey: id },
      );
      return presentOne(tx, principal, retried);
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_send_failed" }, 409);
    return c.json(result, 200);
  });
}

async function draftExists(tx: TenantTx, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id));
  return row !== undefined;
}
