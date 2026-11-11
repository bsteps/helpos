import type { Database } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { apiRoute } from "../auth/access.ts";
import { json } from "../http/route-kit.ts";
import type { Clock, ServerConfig } from "../services.ts";
import { aiBudget } from "./budget.ts";

export interface AiUsageRouteDeps {
  db: Pick<Database, "withTenant">;
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget">;
  logger: Pick<Logger, "warn">;
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

const usageRoute = apiRoute({
  access: { allScopes: ["conversations:read"] },
  method: "get",
  path: "/v1/ai-usage",
  summary: "Today's AI usage for this workspace",
  description:
    "Tokens the workspace's AI calls (reply and issue drafts, knowledge embeddings) used " +
    "today (UTC), against its hard daily budget. Calls still in flight aren't counted yet. " +
    "At or over the budget, no model call is made and new conversations are marked " +
    "`ai_paused_reason: daily_budget` until UTC midnight. Needs `conversations:read`.",
  responses: {
    200: json(usageSchema, "Usage"),
  },
});

export function registerAiUsageRoute(app: OpenAPIHono, deps: AiUsageRouteDeps): void {
  const budget = aiBudget(deps);
  app.openapi(usageRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const { budget: dailyTokenBudget, ...today } = await deps.db.withTenant(tenantId, (tx) =>
      budget.today(tx, tenantId),
    );
    return c.json({ ...today, dailyTokenBudget }, 200);
  });
}
