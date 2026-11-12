import { type Database, eq, schema } from "@helpos/db";
import { builtInActors } from "@helpos/db/actor";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";

const { tenants } = schema;

export const setAiBudgetInput = z.object({
  tenantId: z.uuid(),
  /** Tokens per UTC day, or null to fall back to the server-wide ceiling. */
  budget: z.number().int().min(0).nullable(),
});

export type SetAiBudgetResult = { ok: true } | { ok: false; reason: "workspace_not_found" };

/**
 * Sets a workspace's own daily AI budget. Operator-only on purpose: there is no API route for
 * it, so a workspace's tokens (or a stolen one) can't raise their own cap. The change and its
 * audit event commit together. The server-wide ceiling still applies on top of this value.
 */
export async function setAiBudget(
  db: Pick<Database, "withTenant">,
  rawInput: z.input<typeof setAiBudgetInput>,
): Promise<SetAiBudgetResult> {
  const input = setAiBudgetInput.parse(rawInput);
  return db.withTenant(input.tenantId, async (tx) => {
    const [updated] = await tx
      .update(tenants)
      .set({ aiDailyTokenBudget: input.budget })
      .where(eq(tenants.id, input.tenantId))
      .returning({ id: tenants.id });
    if (!updated) return { ok: false, reason: "workspace_not_found" } as const;
    await recordAudit(tx, {
      tenantId: input.tenantId,
      actor: builtInActors.operatorCli,
      action: "workspace.ai_budget_changed",
      target: { type: "workspace", id: input.tenantId },
      requestId: null,
    });
    return { ok: true } as const;
  });
}
