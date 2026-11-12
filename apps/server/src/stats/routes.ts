import { and, type Database, eq, gte, inArray, lt, schema, type TenantTx } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiRoute } from "../auth/access.ts";
import { draftWhere } from "../drafts/lifecycle.ts";
import { errorSchema, json } from "../http/route-kit.ts";
import type { Clock } from "../services.ts";
import { countDraftOutcomes, type DraftOutcomes } from "./draft-outcomes.ts";

export interface StatsRoutesDeps {
  db: Pick<Database, "withTenant">;
  clock: Clock;
}

const { auditEvents, drafts } = schema;
const day = 24 * 60 * 60 * 1000;
/** A year and a bit: long enough for any trial, short enough to stay a cheap query. */
const maxRangeDays = 400;

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

const draftStatsRoute = apiRoute({
  access: { allScopes: ["stats:read"] },
  method: "get",
  path: "/v1/stats/drafts",
  summary: "How many drafts were approved unchanged",
  description:
    "Outcomes of the drafts created in a date range: approved unchanged, approved after an " +
    "edit (by anyone), discarded, still pending, and the share of approved drafts that went " +
    `out unchanged. The range is at most ${maxRangeDays} days. Needs \`stats:read\`.`,
  request: { query },
  responses: {
    200: json(draftStatsSchema, "The counts"),
    400: json(errorSchema, "`from` is not before `to`, or the range is too long"),
  },
});

/** The query: the facts the counting needs, nothing else. */
async function draftOutcomes(tx: TenantTx, from: Date, to: Date): Promise<DraftOutcomes> {
  const rows = await tx
    // approved_at is set once, at approval, and never cleared.
    .select({
      id: drafts.id,
      status: drafts.status,
      approved: draftWhere.wasApproved(),
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
  app.openapi(draftStatsRoute, async (c) => {
    const principal = c.get("principal");
    const params = c.req.valid("query");
    const to = params.to ? new Date(params.to) : deps.clock.now();
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
