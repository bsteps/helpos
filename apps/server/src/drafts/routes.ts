import { and, asc, type Database, enqueue, eq, schema, type TenantTx, uuidv7 } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { recordAudit } from "../audit/audit.ts";
import { type Authenticate, requirePrincipal, type Scope } from "../auth/principal.ts";
import { sendReplyJob } from "./jobs.ts";

const { drafts, mailboxes, tickets } = schema;
type DraftRow = typeof drafts.$inferSelect;

export interface DraftRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
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
    "becomes `sent` once the email is out, and a failed send is retried. Needs `drafts:approve`.",
  security,
  request: { params: idParams },
  responses: {
    200: json(draftSchema, "The approved draft"),
    ...authErrors,
    409: json(errorSchema, "The draft is no longer pending"),
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
          approvedAt: new Date(),
          outboundMessageIdHeader: `<${uuidv7()}@${domain}>`,
        })
        .where(and(eq(drafts.id, id), eq(drafts.status, "pending")))
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
}

async function draftExists(tx: TenantTx, id: string): Promise<boolean> {
  const [row] = await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id));
  return row !== undefined;
}
