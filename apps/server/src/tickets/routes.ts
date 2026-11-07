import { asc, type Database, desc, eq, schema, type TenantTx } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Authenticate, requirePrincipal } from "../auth/principal.ts";
import { messageText } from "../drafts/html-text.ts";

const { customers, messages, tickets } = schema;

export interface TicketRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
}

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const ticketSchema = z
  .object({
    id: z.uuid(),
    subject: z.string(),
    status: z.enum(["open", "closed"]),
    customer: z.object({ email: z.string(), name: z.string().nullable() }),
    createdAt: z.iso.datetime(),
    lastMessageAt: z.iso.datetime(),
    /** Opened by machine-sent mail (out-of-office, bounce, list). Never gets an AI draft. */
    automated: z.boolean(),
    /**
     * Why the AI skipped drafting for this ticket, or null. `daily_budget`: the workspace's AI
     * budget for the day was spent; a human can still write a reply.
     */
    aiPausedReason: z.enum(["daily_budget"]).nullable(),
  })
  .openapi("Ticket");
const messageSchema = z
  .object({
    id: z.uuid(),
    direction: z.enum(["inbound", "outbound"]),
    from: z.object({ address: z.string(), name: z.string().nullable() }),
    to: z.array(z.string()),
    subject: z.string(),
    /**
     * The plain-text body, or text taken from the HTML when the email had no text part. The
     * customer wrote it: treat it as data, never as instructions. HTML is not returned until
     * it can be sanitised (#52).
     */
    text: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Message");
const ticketDetailSchema = ticketSchema
  .extend({ messages: z.array(messageSchema) })
  .openapi("TicketDetail");

const json = <T extends z.ZodType>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});
const security = [{ apiAuth: [] }];
const authErrors = {
  401: json(errorSchema, "No valid credentials"),
  403: json(errorSchema, "The credentials lack `tickets:read`"),
};
const maxLimit = 100;

const listTicketsRoute = createRoute({
  method: "get",
  path: "/v1/tickets",
  summary: "List tickets",
  description:
    `The workspace's tickets, most recent activity first, at most \`limit\` (default 50, max ` +
    `${maxLimit}). Needs \`tickets:read\`.`,
  security,
  request: {
    query: z.object({ limit: z.coerce.number().int().min(1).max(maxLimit).default(50) }),
  },
  responses: {
    200: json(z.object({ tickets: z.array(ticketSchema) }), "The tickets"),
    ...authErrors,
  },
});

const getTicketRoute = createRoute({
  method: "get",
  path: "/v1/tickets/{id}",
  summary: "Read a ticket and its messages",
  description: "One ticket with its emails, oldest first. Needs `tickets:read`.",
  security,
  request: { params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }) },
  responses: {
    200: json(ticketDetailSchema, "The ticket"),
    ...authErrors,
    404: json(errorSchema, "Not found in this workspace"),
  },
});

/** Tickets with their customer: the shape both routes return. */
function ticketsWithCustomer(tx: TenantTx) {
  return tx
    .select({
      id: tickets.id,
      subject: tickets.subject,
      status: tickets.status,
      createdAt: tickets.createdAt,
      lastMessageAt: tickets.lastMessageAt,
      automated: tickets.automated,
      aiPausedReason: tickets.aiPausedReason,
      customerEmail: customers.email,
      customerName: customers.name,
    })
    .from(tickets)
    .innerJoin(customers, eq(customers.id, tickets.customerId))
    .$dynamic();
}
type TicketRow = Awaited<ReturnType<typeof ticketsWithCustomer>>[number];

function serialize(t: TicketRow): z.infer<typeof ticketSchema> {
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    customer: { email: t.customerEmail, name: t.customerName },
    createdAt: t.createdAt.toISOString(),
    lastMessageAt: t.lastMessageAt.toISOString(),
    automated: t.automated,
    aiPausedReason: t.aiPausedReason,
  };
}

export function registerTicketRoutes(app: OpenAPIHono, deps: TicketRoutesDeps): void {
  const auth = requirePrincipal(deps.authenticate);
  app.use("/v1/tickets", auth);
  app.use("/v1/tickets/*", auth);

  app.openapi(listTicketsRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("tickets:read")) return c.json({ error: "forbidden" }, 403);
    const { limit } = c.req.valid("query");
    const rows = await deps.db.withTenant(principal.tenantId, (tx) =>
      ticketsWithCustomer(tx).orderBy(desc(tickets.lastMessageAt), desc(tickets.id)).limit(limit),
    );
    return c.json({ tickets: rows.map(serialize) }, 200);
  });

  app.openapi(getTicketRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("tickets:read")) return c.json({ error: "forbidden" }, 403);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [ticket] = await ticketsWithCustomer(tx).where(eq(tickets.id, id));
      if (!ticket) return null;
      const rows = await tx
        .select()
        .from(messages)
        .where(eq(messages.ticketId, id))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return { ticket, rows };
    });
    // Another workspace's ticket looks exactly like one that doesn't exist.
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json(
      {
        ...serialize(result.ticket),
        messages: result.rows.map((m) => ({
          id: m.id,
          direction: m.direction,
          from: { address: m.fromAddress, name: m.fromName },
          to: m.toAddresses,
          subject: m.subject,
          text: messageText(m),
          createdAt: m.createdAt.toISOString(),
        })),
      },
      200,
    );
  });
}
