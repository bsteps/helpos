import { and, eq, schema, sql, type TenantTx } from "@helpos/db";

const { aiUsage, tenants } = schema;

/**
 * Tokens per workspace per UTC day. Low on purpose: an email flood to a public demo mailbox
 * must not become an unbounded bill. Override with HELPOS_AI_DAILY_TOKEN_BUDGET.
 */
export const defaultDailyTokenBudget = 200_000;

/**
 * The budget that applies: the workspace's own, but never above the server-wide ceiling, so a
 * bad or missing value can't mean an unlimited bill. Null means the workspace has none of its own.
 */
export function effectiveBudget(workspaceBudget: number | null, ceiling: number): number {
  return workspaceBudget === null ? ceiling : Math.min(workspaceBudget, ceiling);
}

/** A workspace's effective daily budget, given the server-wide ceiling. */
export async function dailyBudget(
  tx: TenantTx,
  tenantId: string,
  ceiling: number,
): Promise<number> {
  const [row] = await tx
    .select({ budget: tenants.aiDailyTokenBudget })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return effectiveBudget(row?.budget ?? null, ceiling);
}

export type DailyUsage = { day: string; inputTokens: number; outputTokens: number; calls: number };

/** The UTC day as `YYYY-MM-DD`. The budget resets when this changes, at UTC midnight. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function totalTokens(usage: Pick<DailyUsage, "inputTokens" | "outputTokens">): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Locks the workspace's usage row for the day (creating it if needed) and returns it. Held
 * until the job's transaction ends, so concurrent draft jobs check the budget one at a time
 * and none can slip past it while another call is in flight.
 */
export async function lockUsage(tx: TenantTx, tenantId: string, day: string): Promise<DailyUsage> {
  await tx
    .insert(aiUsage)
    .values({ tenantId, day })
    .onConflictDoNothing({
      target: [aiUsage.tenantId, aiUsage.day],
    });
  const [row] = await tx
    .select({
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      calls: aiUsage.calls,
    })
    .from(aiUsage)
    .where(eq(aiUsage.day, day))
    .for("update");
  return { day, inputTokens: 0, outputTokens: 0, calls: 0, ...row };
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

/**
 * Reserves `tokens` of today's budget before a model call, in one statement: the row lock is
 * held only for that statement, never across the call. False when the reservation doesn't fit
 * under `budget`, so concurrent calls can't all slip past the cap at once. The reservation
 * counts as input tokens and as one call until settleUsage() replaces it.
 */
export async function reserveUsage(
  tx: TenantTx,
  tenantId: string,
  day: string,
  tokens: number,
  budget: number,
): Promise<boolean> {
  await tx
    .insert(aiUsage)
    .values({ tenantId, day })
    .onConflictDoNothing({ target: [aiUsage.tenantId, aiUsage.day] });
  const reserved = await tx
    .update(aiUsage)
    .set({
      inputTokens: sql`${aiUsage.inputTokens} + ${tokens}`,
      calls: sql`${aiUsage.calls} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiUsage.day, day),
        sql`${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${tokens} <= ${budget}`,
      ),
    )
    .returning({ id: aiUsage.id });
  return reserved.length > 0;
}

/**
 * Replaces a reservation with what the call really used. With `used` null (the call failed and
 * cost nothing), the reservation and its call are released.
 */
export async function settleUsage(
  tx: TenantTx,
  day: string,
  reserved: number,
  used: { inputTokens: number; outputTokens: number } | null,
): Promise<void> {
  await tx
    .update(aiUsage)
    .set({
      inputTokens: sql`greatest(0, ${aiUsage.inputTokens} - ${reserved} + ${used?.inputTokens ?? 0})`,
      outputTokens: sql`${aiUsage.outputTokens} + ${used?.outputTokens ?? 0}`,
      calls: used ? sql`${aiUsage.calls}` : sql`greatest(0, ${aiUsage.calls} - 1)`,
      updatedAt: new Date(),
    })
    .where(eq(aiUsage.day, day));
}
