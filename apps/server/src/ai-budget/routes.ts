import type { Database } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiRoute } from "../auth/access.ts";
import { type Authenticate, requirePrincipal } from "../auth/principal.ts";
import { dailyBudget, totalTokens, usageOn, utcDay } from "./budget.ts";

export interface AiUsageRouteDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
  dailyTokenBudget: number;
  now?: () => Date;
}

const usageSchema = z
  .object({
    /** The UTC day this covers, `YYYY-MM-DD`. The budget resets at UTC midnight. */
    day: z.string(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    totalTokens: z.number().int(),
    calls: z.number().int(),
    /** The effective budget: the workspace's own, capped by the server-wide ceiling. */
    dailyTokenBudget: z.number().int(),
    remainingTokens: z.number().int(),
    /** True when drafting is paused until the next UTC day. */
    paused: z.boolean(),
  })
  .openapi("AiUsage");
const errorSchema = z.object({ error: z.string() }).openapi("Error");

const usageRoute = apiRoute({
  access: { allScopes: ["tickets:read"] },
  method: "get",
  path: "/v1/ai-usage",
  summary: "Today's AI usage for this workspace",
  description:
    "Tokens the workspace's AI drafting used today (UTC), against its hard daily budget. " +
    "At or over the budget, no model call is made and new tickets are marked " +
    "`ai_paused_reason: daily_budget` until UTC midnight. Needs `tickets:read`.",
  security: [{ apiAuth: [] }],
  responses: {
    200: { description: "Usage", content: { "application/json": { schema: usageSchema } } },
    401: {
      description: "No valid credentials",
      content: { "application/json": { schema: errorSchema } },
    },
    403: { description: "Missing scope", content: { "application/json": { schema: errorSchema } } },
  },
});

export function registerAiUsageRoute(app: OpenAPIHono, deps: AiUsageRouteDeps): void {
  app.use(usageRoute.path, requirePrincipal(deps.authenticate));
  app.openapi(usageRoute, async (c) => {
    const principal = c.get("principal");
    const day = utcDay((deps.now ?? (() => new Date()))());
    const [usage, budget] = await deps.db.withTenant(principal.tenantId, async (tx) => [
      await usageOn(tx, day),
      await dailyBudget(tx, principal.tenantId, deps.dailyTokenBudget),
    ]);
    const total = totalTokens(usage);
    return c.json(
      {
        ...usage,
        totalTokens: total,
        dailyTokenBudget: budget,
        remainingTokens: Math.max(0, budget - total),
        paused: total >= budget,
      },
      200,
    );
  });
}
