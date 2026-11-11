import type { DraftUsage, PaidModels } from "@helpos/ai";
import { withPaidModels } from "@helpos/ai/budget";
import { and, eq, schema, sql, type TenantTransaction, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import type { Clock, ServerConfig } from "../services.ts";

// The one way an AI call is paid for. Every call follows the same steps:
//
// 1. reserve() its upper-bound estimate, in one statement, in a short transaction that commits
//    before the call. Refused when today's budget is spent, or when calls already in flight
//    hold the rest of it.
// 2. spend() makes the call, holding no transaction and no lock, then settles the reservation
//    in its own transaction: to what the call cost, success or failure.
//
// The row lock is held only for that one statement, so a slow call never makes another wait,
// and two concurrent calls can't both slip under the cap: the second sees the first's
// reservation.
//
// A reservation runs out after `reservationSeconds`. A call can't outlive it: spend() aborts it
// after `aiCallTimeoutMs`, or as soon as the server starts shutting down, and settles it. So
// only a process that dies mid-call leaves a reservation unsettled, and that one stops holding
// the budget once it runs out: it becomes conservative spend, never a free call.

const { aiUsage, tenants } = schema;

/** The longest one AI call may run: spend() aborts it then, and settles it. */
const aiCallTimeoutMs = 4 * 60_000;
/**
 * How long a reservation holds the budget. Well past aiCallTimeoutMs, so a call has always
 * settled (or its process died) before its reservation runs out.
 */
const reservationSeconds = 10 * 60;
const reservationWindow = sql.raw(`interval '${reservationSeconds} seconds'`);
/** The reservations that still hold the budget: none once the newest has run out. */
const liveReserved = sql`(case when ${aiUsage.reservedUntil} > now() then ${aiUsage.reservedTokens} else 0 end)`;

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

/** The UTC day as `YYYY-MM-DD`. The budget resets when this changes, at UTC midnight. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The start of the next UTC day, when the daily budget resets. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export type Spent = DraftUsage;

/** Today's spend against the budget. Reservations of calls in flight aren't in it. */
interface BudgetToday {
  day: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  totalTokens: number;
  /** The effective budget: the workspace's own, capped by the server-wide ceiling. */
  budget: number;
  remainingTokens: number;
  /** Spent: reserve() refuses with `over_budget` until the next UTC day. */
  paused: boolean;
}

/** Tokens held for one call in flight. Only spend() settles it. */
export interface Reservation {
  readonly tenantId: string;
  /** The day it was taken on: it settles there, even if the call ends after midnight. */
  readonly day: string;
  readonly tokens: number;
  /** When it runs out, by the database's clock. A settle after that leaves the tokens alone. */
  readonly expiresAt: Date;
}

/**
 * Why reserve() said no. `over_budget`: today's budget is spent, until UTC midnight.
 * `busy`: it isn't, but calls in flight hold the rest of it; try again once they settle.
 */
export interface AiRefusal {
  refused: "over_budget" | "busy";
  retryAt: Date;
}

export function dailyBudgetRefusal(today: Pick<BudgetToday, "paused" | "day">): AiRefusal | null {
  return today.paused ? { refused: "over_budget", retryAt: nextUtcDay(new Date(today.day)) } : null;
}

export function mapAiRefusal<T>(
  refusal: AiRefusal,
  handlers: Record<AiRefusal["refused"], (retryAt: Date) => T>,
): T {
  return handlers[refusal.refused](refusal.retryAt);
}

/**
 * What a failed call cost, as far as can be told: the usage it reported, `none` when it
 * wasn't billed, or `unknown`, which keeps the whole reservation counted as spent.
 */
type FailureCost = Spent | "none" | "unknown";

export interface AiBudgetDeps {
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget">;
  logger: Pick<Logger, "warn">;
  /**
   * Aborted when the server starts shutting down: every call in flight stops then, and is
   * settled before the database closes. Tests that never shut down leave it out.
   */
  shutdown?: AbortSignal | undefined;
}

export interface AiBudget {
  today(tx: TenantTx, tenantId: string): Promise<BudgetToday>;
  /** Run in a short transaction that commits before the call, so the lock is let go. */
  reserve(tx: TenantTx, tenantId: string, estimate: number): Promise<Reservation | AiRefusal>;
  /**
   * Makes the call, then settles the reservation in its own transaction: to `cost.of` the
   * result, or `cost.ofFailure` the error, which is then rethrown. A settle that fails is
   * logged and leaves the reservation counted. The call must pass `signal` to every AI call
   * it makes: it aborts after aiCallTimeoutMs, or when the server shuts down.
   */
  spend<T>(
    transaction: TenantTransaction,
    reservation: Reservation,
    call: (signal: AbortSignal, models: PaidModels) => Promise<T>,
    cost: { of: (result: T) => Spent; ofFailure: (error: unknown) => FailureCost },
  ): Promise<T>;
}

/**
 * The budget for every AI call: reply drafts, GitHub issue drafts and knowledge embeddings.
 * The only code that reads the budget or writes ai_usage (a Biome plugin keeps it so).
 */
export function aiBudget(deps: AiBudgetDeps): AiBudget {
  const ceiling = deps.config.dailyTokenBudget;
  const workspaceBudget = async (tx: TenantTx, tenantId: string) => {
    const [row] = await tx
      .select({ budget: tenants.aiDailyTokenBudget })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return effectiveBudget(row?.budget ?? null, ceiling);
  };

  return {
    async today(tx, tenantId) {
      const day = utcDay(deps.clock.now());
      await chargeExpired(tx, day);
      const [usage, budget] = [await spentOn(tx, day), await workspaceBudget(tx, tenantId)];
      const totalTokens = usage.inputTokens + usage.outputTokens;
      return {
        day,
        ...usage,
        totalTokens,
        budget,
        remainingTokens: Math.max(0, budget - totalTokens),
        paused: totalTokens >= budget,
      };
    },

    async reserve(tx, tenantId, estimate) {
      const day = utcDay(deps.clock.now());
      const tokens = Math.max(0, Math.ceil(estimate));
      const budget = await workspaceBudget(tx, tenantId);
      await tx
        .insert(aiUsage)
        .values({ tenantId, day })
        .onConflictDoNothing({ target: [aiUsage.tenantId, aiUsage.day] });
      await chargeExpired(tx, day);
      // One statement: Postgres re-checks the condition against a concurrent reservation's
      // committed row, so two calls can't both fit into the same room. Room means anything
      // left: a call bigger than what's left still runs once, and overshoots by at most itself.
      // Expired reservations were charged above; newer calls extend the shared hold window.
      const [reserved] = await tx
        .update(aiUsage)
        .set({
          reservedTokens: sql`${liveReserved} + ${tokens}`,
          reservedUntil: sql`greatest(${aiUsage.reservedUntil}, now() + ${reservationWindow})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiUsage.day, day),
            sql`${aiUsage.inputTokens} + ${aiUsage.outputTokens} + ${liveReserved} < ${budget}`,
          ),
        )
        .returning({
          expiresAtMs: sql<number>`extract(epoch from now() + ${reservationWindow}) * 1000`.mapWith(
            Number,
          ),
        });
      if (reserved) return { tenantId, day, tokens, expiresAt: new Date(reserved.expiresAtMs) };
      const usage = await spentOn(tx, day);
      return usage.inputTokens + usage.outputTokens >= budget
        ? { refused: "over_budget", retryAt: nextUtcDay(new Date(day)) }
        : { refused: "busy", retryAt: new Date(deps.clock.now().getTime() + 30_000) };
    },

    async spend(transaction, reservation, call, cost) {
      const settleQuietly = async (spent: FailureCost) => {
        try {
          await transaction((tx) => settle(tx, reservation, spent));
        } catch (error) {
          deps.logger.warn(
            { err: error, reservedTokens: reservation.tokens },
            "AI usage not settled: the reservation stays counted",
          );
        }
      };
      const timeout = AbortSignal.timeout(aiCallTimeoutMs);
      const signal = deps.shutdown ? AbortSignal.any([timeout, deps.shutdown]) : timeout;
      let result: Awaited<ReturnType<typeof call>>;
      try {
        result = await withPaidModels(signal, (models) => call(signal, models));
      } catch (error) {
        await settleQuietly(cost.ofFailure(error));
        throw error;
      }
      await settleQuietly(cost.of(result));
      return result;
    },
  };
}

/** The current workspace's spend on one day (zero if it made no calls). */
async function spentOn(tx: TenantTx, day: string) {
  const [row] = await tx
    .select({
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      calls: aiUsage.calls,
    })
    .from(aiUsage)
    .where(eq(aiUsage.day, day));
  return { inputTokens: 0, outputTokens: 0, calls: 0, ...row };
}

/**
 * Lets the reservation go and adds what the call cost. A call counts when it cost anything;
 * one whose cost is unknown counts its whole reservation. A reservation that already ran out
 * keeps its full bound as conservative spend (or waits for chargeExpired to count it).
 * It cannot subtract tokens from a newer call's reservation.
 */
async function settle(tx: TenantTx, reservation: Reservation, cost: FailureCost): Promise<void> {
  const spent =
    cost === "unknown"
      ? { inputTokens: reservation.tokens, outputTokens: 0 }
      : cost === "none"
        ? { inputTokens: 0, outputTokens: 0 }
        : cost;
  const paid = spent.inputTokens + spent.outputTokens > 0 ? 1 : 0;
  await tx
    .update(aiUsage)
    .set({
      reservedTokens: sql`case when now() < ${reservation.expiresAt.toISOString()}::timestamptz
        then greatest(0, ${aiUsage.reservedTokens} - ${reservation.tokens})
        else ${aiUsage.reservedTokens} end`,
      inputTokens: sql`${aiUsage.inputTokens} + ${spent.inputTokens}`,
      outputTokens: sql`${aiUsage.outputTokens} + ${spent.outputTokens}`,
      calls: sql`${aiUsage.calls} + ${paid}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiUsage.tenantId, reservation.tenantId),
        eq(aiUsage.day, reservation.day),
        sql`now() < ${reservation.expiresAt.toISOString()}::timestamptz`,
      ),
    );
}

/** Unknown bills remain counted after a crash or a failed settle; only their hold expires. */
async function chargeExpired(tx: TenantTx, day: string): Promise<void> {
  await tx
    .update(aiUsage)
    .set({
      inputTokens: sql`${aiUsage.inputTokens} + ${aiUsage.reservedTokens}`,
      calls: sql`${aiUsage.calls} + case when ${aiUsage.reservedTokens} > 0 then 1 else 0 end`,
      reservedTokens: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiUsage.day, day),
        sql`${aiUsage.reservedUntil} <= now()`,
        sql`${aiUsage.reservedTokens} > 0`,
      ),
    );
}
