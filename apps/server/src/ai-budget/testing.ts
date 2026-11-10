// For tests only: read and seed a workspace's AI usage without going through a model call.
import { type Database, eq, schema, sql } from "@helpos/db";
import { utcDay } from "./budget.ts";

const { aiUsage } = schema;

/** A workspace's usage row for one day (zeros if it made no calls), with its total spend. */
export async function usageOn(
  db: Pick<Database, "withTenant">,
  tenantId: string,
  now = new Date(),
): Promise<{
  inputTokens: number;
  outputTokens: number;
  calls: number;
  reservedTokens: number;
  totalTokens: number;
}> {
  const [row] = await db.withTenant(tenantId, (tx) =>
    tx
      .select({
        inputTokens: aiUsage.inputTokens,
        outputTokens: aiUsage.outputTokens,
        calls: aiUsage.calls,
        reservedTokens: aiUsage.reservedTokens,
      })
      .from(aiUsage)
      .where(eq(aiUsage.day, utcDay(now))),
  );
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0, reservedTokens: 0, ...row };
  return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
}

/** Adds spend to a workspace's day, as if calls had made it. */
export async function seedUsage(
  db: Pick<Database, "withTenant">,
  tenantId: string,
  day: string,
  inputTokens: number,
): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    await tx
      .insert(aiUsage)
      .values({ tenantId, day })
      .onConflictDoNothing({ target: [aiUsage.tenantId, aiUsage.day] });
    const [row] = await tx
      .select({ inputTokens: aiUsage.inputTokens })
      .from(aiUsage)
      .where(eq(aiUsage.day, day));
    await tx
      .update(aiUsage)
      .set({ inputTokens: (row?.inputTokens ?? 0) + inputTokens })
      .where(eq(aiUsage.day, day));
  });
}

/**
 * Holds tokens on a workspace's day as an unsettled call would (one whose process died),
 * running out `seconds` from now: negative for one that already ran out.
 */
export async function seedReservation(
  db: Pick<Database, "withTenant">,
  tenantId: string,
  day: string,
  tokens: number,
  seconds: number,
): Promise<void> {
  await db.withTenant(tenantId, async (tx) => {
    await tx
      .insert(aiUsage)
      .values({ tenantId, day })
      .onConflictDoNothing({ target: [aiUsage.tenantId, aiUsage.day] });
    await tx
      .update(aiUsage)
      .set({
        reservedTokens: tokens,
        reservedUntil: sql`now() + make_interval(secs => ${seconds})`,
      })
      .where(eq(aiUsage.day, day));
  });
}
