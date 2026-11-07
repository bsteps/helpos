import { eq, schema, sql, type TenantTx } from "@helpos/db";

const { aiUsage } = schema;

/**
 * Tokens per workspace per UTC day. Low on purpose: an email flood to a public demo mailbox
 * must not become an unbounded bill. Override with HELPOS_AI_DAILY_TOKEN_BUDGET.
 */
export const defaultDailyTokenBudget = 200_000;

export type DailyUsage = { day: string; inputTokens: number; outputTokens: number; calls: number };

/** The UTC day as `YYYY-MM-DD`. The budget resets when this changes, at UTC midnight. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function totalTokens(usage: Pick<DailyUsage, "inputTokens" | "outputTokens">): number {
  return usage.inputTokens + usage.outputTokens;
}

/** The current workspace's usage for one day (zero if it made no calls). */
export async function usageOn(tx: TenantTx, day: string): Promise<DailyUsage> {
  const [row] = await tx
    .select({
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      calls: aiUsage.calls,
    })
    .from(aiUsage)
    .where(eq(aiUsage.day, day));
  return { day, inputTokens: 0, outputTokens: 0, calls: 0, ...row };
}

/** Adds one model call's tokens to the day's total. Atomic, so concurrent jobs both count. */
export async function recordUsage(
  tx: TenantTx,
  tenantId: string,
  day: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  await tx
    .insert(aiUsage)
    .values({ tenantId, day, ...usage, calls: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.tenantId, aiUsage.day],
      set: {
        inputTokens: sql`${aiUsage.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${aiUsage.outputTokens} + excluded.output_tokens`,
        calls: sql`${aiUsage.calls} + 1`,
        updatedAt: new Date(),
      },
    });
}
