import { and, type Database, eq, gte, inArray, lt, schema, sql, type TenantTx } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Authenticate, requirePrincipal } from "../auth/principal.ts";
import { countDraftOutcomes, type DraftOutcomes } from "./draft-outcomes.ts";

export interface StatsRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
  now?: () => Date;
}

const { auditEvents, drafts } = schema;
const day = 24 * 60 * 60 * 1000;
/** A year and a bit: long enough for any trial, short enough to stay a cheap query. */
const maxRangeDays = 400;

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const draftStatsSchema = z
  .object({
    /** The range counted: drafts created at or after `from` and before `to`. */
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    /**
     * Approved with the AI's text exactly as written, whatever happened next: sent, still
     * sending, or a send that failed (even if then discarded).
     */
    approvedUnchanged: z.number().int(),
    /** Approved after a human or an agent edited it, once or more. */
    approvedEdited: z.number().int(),
    /** Discarded without ever being approved. */
    discarded: z.number().int(),
    pending: z.number().int(),
    /** approvedUnchanged ÷ all approved, from 0 to 1. Null when nothing was approved. */
    unchangedRate: z.number().min(0).max(1).nullable(),
  })
  .openapi("DraftStats");

const query = z.object({
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .openapi({ description: "Start of the range. Defaults to 14 days before `to`." }),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .openapi({ description: "End of the range, exclusive. Defaults to now." }),
});

const json = <T extends z.ZodType>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});

const draftStatsRoute = createRoute({
  method: "get",
  path: "/v1/stats/drafts",
  summary: "How many drafts were approved unchanged",
  description:
    "Outcomes of the drafts created in a date range: approved unchanged, approved after an " +
    "edit (by anyone), discarded, still pending, and the share of approved drafts that went " +
    `out unchanged. The range is at most ${maxRangeDays} days. Needs \`stats:read\`.`,
  security: [{ apiAuth: [] }],
  request: { query },
  responses: {
    200: json(draftStatsSchema, "The counts"),
    400: json(errorSchema, "`from` is not before `to`, or the range is too long"),
    401: json(errorSchema, "No valid credentials"),
    403: json(errorSchema, "The credentials lack the required scope"),
  },
});

/** The query: the facts the counting needs, nothing else. */
async function draftOutcomes(tx: TenantTx, from: Date, to: Date): Promise<DraftOutcomes> {
  const rows = await tx
    // approved_at is set once, at approval, and never cleared.
    .select({
      id: drafts.id,
      status: drafts.status,
      approved: sql<boolean>`${drafts.approvedAt} is not null`,
    })
    .from(drafts)
    .where(and(gte(drafts.createdAt, from), lt(drafts.createdAt, to)));
  const ids = rows.map((r) => r.id);
  const edits =
    ids.length === 0
      ? []
      : await tx
          .select({ draftId: auditEvents.targetId, actorType: auditEvents.actorType })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, "draft.edited"),
              eq(auditEvents.targetType, "draft"),
              inArray(auditEvents.targetId, ids),
            ),
          );
  return countDraftOutcomes(rows, edits);
}

export function registerStatsRoutes(app: OpenAPIHono, deps: StatsRoutesDeps): void {
  app.use(draftStatsRoute.path, requirePrincipal(deps.authenticate));
  app.openapi(draftStatsRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("stats:read")) return c.json({ error: "forbidden" }, 403);
    const params = c.req.valid("query");
    const to = params.to ? new Date(params.to) : (deps.now ?? (() => new Date()))();
    const from = params.from ? new Date(params.from) : new Date(to.getTime() - 14 * day);
    if (from >= to) return c.json({ error: "empty_range" }, 400);
    if (to.getTime() - from.getTime() > maxRangeDays * day) {
      return c.json({ error: "range_too_long" }, 400);
    }
    const outcomes = await deps.db.withTenant(principal.tenantId, (tx) =>
      draftOutcomes(tx, from, to),
    );
    return c.json({ from: from.toISOString(), to: to.toISOString(), ...outcomes }, 200);
  });
}
