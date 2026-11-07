import {
  and,
  asc,
  type Database,
  desc,
  enqueue,
  eq,
  isNull,
  ne,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { totalTokens, usageOn, utcDay } from "../ai-budget/budget.ts";
import { recordAudit } from "../audit/audit.ts";
import { type Authenticate, requirePrincipal, type Scope } from "../auth/principal.ts";
import { draftReplyJob, sendReplyJob } from "./jobs.ts";
import { queueDraftNotice } from "./notice-worker.ts";

const { drafts, mailboxes, messages, tickets } = schema;
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
const draftSchema = z
  .object({
    id: z.uuid(),
    ticketId: z.uuid(),
    /** The inbound message this draft answers. */
    messageId: z.uuid(),
    status: z.enum(schema.draftStatuses),
    body: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    approvedAt: z.iso.datetime().nullable(),
    sentAt: z.iso.datetime().nullable(),
  })
  .openapi("Draft");

const idParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const authErrors = {
  401: json(errorSchema, "No valid credentials"),
  403: json(errorSchema, "The credentials lack the required scope"),
  404: json(errorSchema, "Not found in this workspace"),
};
const security = [{ apiAuth: [] }];

const listRoute = createRoute({
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

const editRoute = createRoute({
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

const approveRoute = createRoute({
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

const discardRoute = createRoute({
  method: "post",
  path: "/v1/drafts/{id}/discard",
  summary: "Discard a pending draft",
  description:
    "Marks a `pending` draft `discarded`, so it can never be approved or sent. Use it for a " +
    "draft that shouldn't go out. Needs `drafts:write`.",
  security,
  request: { params: idParams },
  responses: {
    200: json(draftSchema, "The discarded draft"),
    ...authErrors,
    409: json(errorSchema, "The draft is no longer pending"),
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/v1/tickets/{id}/drafts",
  summary: "Write a draft, or ask the AI for a new one",
  description:
    "Answers the ticket's latest customer message. With `body`, saves that text as a " +
    "`pending` draft (201). With `regenerate: true`, queues a fresh AI draft (202): it " +
    "appears in the list when ready. Either way, older pending drafts on the ticket are " +
    "discarded. Nothing is sent until the draft is approved. Needs `drafts:write`.",
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

function serialize(d: DraftRow): z.infer<typeof draftSchema> {
  return {
    id: d.id,
    ticketId: d.ticketId,
    messageId: d.messageId,
    status: d.status,
    body: d.body,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    approvedAt: d.approvedAt?.toISOString() ?? null,
    sentAt: d.sentAt?.toISOString() ?? null,
  };
}

/** The principal set by requirePrincipal(), if it holds `scope`. */
function principalWith(c: Context, scope: Scope) {
  const principal = c.get("principal");
  return principal.scopes.has(scope) ? principal : null;
}

export function registerDraftRoutes(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "apiAuth", {
    type: "http",
    scheme: "bearer",
    description:
      "An agent token (`hos_…`) or a human session. Neither exists yet (#49, #46): until " +
      "then every request to these routes is refused with 401.",
  });
  const auth = requirePrincipal(deps.authenticate);
  app.use("/v1/tickets/*", auth);
  app.use("/v1/drafts/*", auth);

  app.openapi(listRoute, async (c) => {
    const principal = principalWith(c, "tickets:read");
    if (!principal) return c.json({ error: "forbidden" }, 403);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [ticket] = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, id));
      if (!ticket) return null;
      return tx.select().from(drafts).where(eq(drafts.ticketId, id)).orderBy(asc(drafts.createdAt));
    });
    // Another workspace's ticket looks exactly like one that doesn't exist.
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json({ drafts: result.map(serialize) }, 200);
  });

  app.openapi(editRoute, async (c) => {
    const principal = principalWith(c, "drafts:write");
    if (!principal) return c.json({ error: "forbidden" }, 403);
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
      return updated;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(serialize(result), 200);
  });

  app.openapi(approveRoute, async (c) => {
    const principal = principalWith(c, "drafts:approve");
    if (!principal) return c.json({ error: "forbidden" }, 403);
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
      return approved;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(serialize(result), 200);
  });

  registerDiscardRoute(app, deps);
  registerCreateRoute(app, deps);
}

function registerCreateRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(createRoute_, async (c) => {
    const principal = principalWith(c, "drafts:write");
    if (!principal) return c.json({ error: "forbidden" }, 403);
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
            ne(drafts.status, "discarded"),
            ne(drafts.status, "pending"),
          ),
        );
      if (answered) return "already_answered" as const;

      // Checked before anything is discarded: a refused regenerate leaves the current draft
      // alone, and the caller hears why instead of waiting for a draft that never comes.
      if ("regenerate" in input) {
        const used = await usageOn(tx, utcDay((deps.now ?? (() => new Date()))()));
        if (totalTokens(used) >= deps.dailyTokenBudget) return "daily_budget_reached" as const;
      }

      const stale = await tx
        .update(drafts)
        .set({ status: "discarded" })
        .where(and(eq(drafts.ticketId, ticketId), eq(drafts.status, "pending")))
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
      return draft;
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
    return c.json(serialize(result), 201);
  });
}

function registerDiscardRoute(app: OpenAPIHono, deps: DraftRoutesDeps): void {
  app.openapi(discardRoute, async (c) => {
    const principal = principalWith(c, "drafts:write");
    if (!principal) return c.json({ error: "forbidden" }, 403);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [discarded] = await tx
        .update(drafts)
        .set({ status: "discarded" })
        .where(and(eq(drafts.id, id), eq(drafts.status, "pending")))
        .returning();
      if (!discarded) return (await draftExists(tx, id)) ? "conflict" : "not_found";
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "draft.discarded",
        target: { type: "draft", id },
        requestId: c.get("requestId"),
      });
      return discarded;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "conflict") return c.json({ error: "not_pending" }, 409);
    return c.json(serialize(result), 200);
  });
}

async function draftExists(tx: TenantTx, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id));
  return row !== undefined;
}
