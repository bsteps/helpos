import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { z } from "zod";
import type { Database, TenantTx } from "./client.ts";

// Background jobs. pg-boss runs as the `jobs` role and owns the
// `pgboss` schema. The app role can only enqueue, through jobs_api.app_enqueue(), and handlers
// only ever see one tenant's data, through withTenant().

const PGBOSS_SCHEMA = "pgboss";
const queueNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/)
  .max(100);

/** A queue whose jobs belong to one tenant. The payload is that tenant's ID plus other IDs. */
export interface TenantJob<P extends { tenantId: string }> {
  kind: "tenant";
  queue: string;
  payload: z.ZodType<P>;
}

/**
 * Defines a tenant job. Payloads carry IDs only, never tenant content: the handler
 * reloads data inside withTenant(), so nothing lingers in job history. `tenantId` is always added.
 * `counters` are whole numbers that say which version of the row the job was queued for (a
 * request count), so a give-up can tell its run is out of date. Never content.
 */
export function defineTenantJob<const K extends string, const C extends string = never>(
  queue: string,
  ids: Record<K, z.ZodUUID>,
  counters?: Record<C, z.ZodNumber>,
): TenantJob<{ tenantId: string } & Record<K, string> & Record<C, number>> {
  const name = queueNameSchema.parse(queue);
  const shape: Record<string, z.ZodType> = { ...ids, ...counters, tenantId: z.uuid() };
  // The shape is UUIDs and whole numbers by construction, so the parsed object has this type.
  const payload = z.strictObject(shape) as unknown as z.ZodType<
    { tenantId: string } & Record<K, string> & Record<C, number>
  >;
  return { kind: "tenant", queue: name, payload };
}

/** The only options app_enqueue() accepts. */
export interface EnqueueOptions {
  /** Dedupe key, scoped to the tenant by app_enqueue(). A duplicate returns the existing job ID. */
  singletonKey?: string;
  startAfter?: Date;
  retryLimit?: number;
}

const enqueueOptionsSchema = z.strictObject({
  singletonKey: z.string().min(1).max(200).optional(),
  startAfter: z.date().optional(),
  retryLimit: z.number().int().min(0).max(20).optional(),
});

/**
 * The only way to send a tenant job. Runs in the caller's withTenant() transaction,
 * so the job commits or rolls back with the action that caused it. Returns the job ID.
 */
export async function enqueue<P extends { tenantId: string }>(
  tx: TenantTx,
  job: TenantJob<P>,
  payload: P,
  options: EnqueueOptions = {},
): Promise<string> {
  const data = job.payload.parse(payload);
  const opts = enqueueOptionsSchema.parse(options);
  const rows = await tx.execute<{ id: string }>(
    sql`select jobs_api.app_enqueue(${job.queue}, ${JSON.stringify(data)}::jsonb, ${JSON.stringify(opts)}::jsonb) as id`,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`app_enqueue returned no job ID for queue ${job.queue}`);
  return id;
}

export type TenantJobHandler<P> = (payload: P, tx: TenantTx) => Promise<void>;

/** Opens one transaction as the job's tenant: every query in it goes through withTenant(). */
export type TenantTransaction = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
export interface JobDeferral {
  deferUntil: Date;
}

/**
 * For a job that waits on the network, such as a page fetch or a model call. It opens short
 * transactions around the wait instead of holding one (and its pooled connection and row
 * locks) for the whole job. It still only ever sees its own tenant's data.
 * Returning a deferral schedules a successor with only the current job's remaining retries.
 */
export type TenantStepsHandler<P> = (
  payload: P,
  transaction: TenantTransaction,
) => Promise<void | JobDeferral>;

/** One tenant's transactions, as a steps handler gets them. Exported for tests. */
export function tenantTransactions(
  db: Pick<Database, "withTenant">,
  tenantId: string,
): TenantTransaction {
  return (fn) => db.withTenant(tenantId, fn);
}

/**
 * How often, and how far apart, a failed job is tried again. Set on the queue, so every job
 * enqueued after it takes it. Without one, pg-boss's defaults apply.
 */
export interface RetryPolicy {
  /** Retries after the first attempt. */
  limit: number;
  /** Wait before the first retry. */
  delaySeconds: number;
  /** Doubles the wait after each retry, up to `maxDelaySeconds`. */
  backoff: boolean;
  maxDelaySeconds?: number;
}

/**
 * How a tenant job runs, and what happens once it has failed for good. `transaction`: the
 * whole job in one withTenant() transaction. `steps`: the handler opens short transactions
 * around network waits instead.
 *
 * `onGiveUp` is required: it runs once, in its own transaction, after the last attempt failed
 * (that attempt's own transaction has rolled back). It marks the work as failed where people
 * see it, so a job that keeps failing is never lost silently. The job still ends up failed in
 * pg-boss.
 */
type TenantWorker<P> = (
  | { transaction: TenantJobHandler<P>; steps?: never }
  | { steps: TenantStepsHandler<P>; transaction?: never }
) & { onGiveUp: TenantJobHandler<P> };

export interface JobRunner {
  /** Starts pg-boss. Call installJobs() first (migrate step). */
  start(): Promise<void>;
  ready(queues: readonly string[]): ReturnType<Database["ping"]>;
  /**
   * Creates the queue if needed, and sets its retry policy when given. enqueue() refuses a
   * queue that doesn't exist yet.
   */
  ensureQueue(job: TenantJob<{ tenantId: string }>, retry?: RetryPolicy): Promise<void>;
  /** Creates the queue if needed and starts working it. */
  work<P extends { tenantId: string }>(job: TenantJob<P>, worker: TenantWorker<P>): Promise<void>;
  stop(): Promise<void>;
}

export interface JobRunnerOptions {
  /** URL for the jobs role (owner of `pgboss`). */
  jobsUrl: string;
  /** App-role database. Tenant handlers reach data only through its withTenant(). */
  db: Database;
  /**
   * pg-boss reports background errors here; without a listener they would crash the process.
   * A stored payload that fails validation is reported here too, once, on its last attempt.
   */
  onError: (error: unknown, context?: { queue: string; jobId: string }) => void;
  pollingIntervalSeconds?: number;
}

/** Named so a log entry says what failed: logs carry an error's name, never its message. */
class InvalidJobPayloadError extends Error {
  override name = "InvalidJobPayloadError";
  constructor() {
    super("Invalid stored job payload");
  }
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const boss = new PgBoss({
    connectionString: options.jobsUrl,
    schema: PGBOSS_SCHEMA,
    // Schema and tables come from installJobs(); the jobs role has no CREATE on the database.
    createSchema: false,
    migrate: false,
    schedule: false,
  });
  boss.on("error", options.onError);
  const pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;

  async function ensureQueue(
    job: TenantJob<{ tenantId: string }>,
    retry?: RetryPolicy,
  ): Promise<void> {
    await boss.createQueue(job.queue);
    if (!retry) return;
    // updateQueue too: createQueue leaves an existing queue's policy as it was.
    await boss.updateQueue(job.queue, {
      retryLimit: retry.limit,
      retryDelay: retry.delaySeconds,
      retryBackoff: retry.backoff,
      retryDelayMax: retry.maxDelaySeconds ?? null,
    });
  }

  async function consume<P extends { tenantId: string }>(
    job: TenantJob<P>,
    run: (payload: P, remainingRetries: number) => Promise<void>,
    onLastFailure?: (payload: P) => Promise<void>,
  ): Promise<void> {
    await boss.createQueue(job.queue);
    // With metadata, to tell the last attempt from one that will be retried.
    const workOptions = { batchSize: 1, pollingIntervalSeconds, includeMetadata: true } as const;
    await boss.work<unknown, unknown, typeof workOptions>(job.queue, workOptions, async (jobs) => {
      for (const { id, data, retryCount, retryLimit } of jobs) {
        const lastAttempt = retryCount >= retryLimit;
        // Re-validate: the row came from a table, and a bad payload must fail, not guess.
        const parsed = job.payload.safeParse(data);
        if (!parsed.success) {
          const error = new InvalidJobPayloadError();
          if (lastAttempt) options.onError(error, { queue: job.queue, jobId: id });
          throw error;
        }
        const payload = parsed.data;
        try {
          await run(payload, retryLimit - retryCount);
        } catch (error) {
          if (onLastFailure && lastAttempt) {
            // Reported, not thrown: the job's own error is the one pg-boss should record.
            await onLastFailure(payload).catch(options.onError);
          }
          throw error;
        }
      }
    });
  }

  async function work<P extends { tenantId: string }>(
    job: TenantJob<P>,
    tenantWorker: TenantWorker<P>,
  ): Promise<void> {
    const { onGiveUp } = tenantWorker;
    await consume(
      job,
      async (payload, remainingRetries) => {
        if (tenantWorker.steps) {
          const result = await tenantWorker.steps(
            payload,
            tenantTransactions(options.db, payload.tenantId),
          );
          if (result) {
            await options.db.withTenant(payload.tenantId, (tx) =>
              enqueue(tx, job, payload, {
                startAfter: result.deferUntil,
                retryLimit: remainingRetries,
              }),
            );
          }
        } else {
          await options.db.withTenant(payload.tenantId, (tx) =>
            tenantWorker.transaction(payload, tx),
          );
        }
      },
      (payload) => options.db.withTenant(payload.tenantId, (tx) => onGiveUp(payload, tx)),
    );
  }

  return {
    ensureQueue,
    ready: async (queues) => {
      try {
        const available = await boss.getQueues();
        const names = new Set(available.map((queue) => queue.name));
        if (!queues.every((name) => names.has(name))) {
          return { ok: false, error: new Error("required queue is missing") };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
    start: async () => {
      await boss.start();
    },
    work,
    stop: () => boss.stop({ graceful: true, timeout: 5_000 }),
  };
}

/**
 * Installs pg-boss's tables and app_enqueue(), as the jobs role. Idempotent; run it with the
 * migrations. app_enqueue()'s SQL matches pg-boss 12.38.0: re-run the jobs tests on upgrade.
 */
export async function installJobs(jobsUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: jobsUrl,
    schema: PGBOSS_SCHEMA,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {}); // start() rejects on failure, which is what callers see
  await boss.start();
  await boss.stop({ graceful: false });

  const client = postgres(jobsUrl, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(APP_ENQUEUE_SQL);
  } finally {
    await client.end({ timeout: 5 });
  }
}

const APP_ENQUEUE_SQL = `
-- SECURITY DEFINER because the app role must add jobs without any privilege on pgboss tables:
-- a plain INSERT grant is not enough for dedupe, which needs SELECT, and SELECT would expose every
-- tenant's jobs. It checks the payload belongs to the caller's tenant, scopes the
-- singleton key to that tenant, and returns only the job ID.
CREATE OR REPLACE FUNCTION jobs_api.app_enqueue(p_queue text, p_payload jsonb, p_options jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_tenant text := p_payload->>'tenantId';
  v_options jsonb := coalesce(p_options, '{}'::jsonb);
  v_key text;
  v_start timestamptz;
  v_queue pgboss.queue%ROWTYPE;
  v_id uuid;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR v_tenant IS NULL
     OR v_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '') THEN
    RAISE EXCEPTION 'app_enqueue: payload tenantId must be the current tenant' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_options) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(v_options) k
    WHERE k NOT IN ('singletonKey', 'startAfter', 'retryLimit')
  ) THEN
    RAISE EXCEPTION 'app_enqueue: unsupported option' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_queue FROM pgboss.queue WHERE name = p_queue;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_enqueue: unknown queue' USING ERRCODE = '22023';
  END IF;

  IF v_options ? 'singletonKey' THEN
    v_key := v_tenant || ':' || (v_options->>'singletonKey');
    -- Serialise the check-then-insert per key, so two concurrent calls get the same job.
    PERFORM pg_advisory_xact_lock(hashtextextended('app_enqueue:' || p_queue || ':' || v_key, 0));
    SELECT id INTO v_id FROM pgboss.job
    WHERE name = p_queue AND singleton_key = v_key AND state < 'completed'
    LIMIT 1;
    IF FOUND THEN
      RETURN v_id;
    END IF;
  END IF;

  v_start := coalesce((v_options->>'startAfter')::timestamptz, pgboss.job_now());
  INSERT INTO pgboss.job (
    name, data, singleton_key, start_after, created_on, retry_limit, retry_delay, retry_backoff,
    retry_delay_max, expire_seconds, deletion_seconds, keep_until, policy, dead_letter,
    heartbeat_seconds
  ) VALUES (
    p_queue, p_payload, v_key, v_start, pgboss.job_now(),
    coalesce((v_options->>'retryLimit')::int, v_queue.retry_limit),
    v_queue.retry_delay, v_queue.retry_backoff, v_queue.retry_delay_max, v_queue.expire_seconds,
    v_queue.deletion_seconds, v_start + v_queue.retention_seconds * interval '1 second',
    v_queue.policy, v_queue.dead_letter, v_queue.heartbeat_seconds
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION jobs_api.app_enqueue(text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_api.app_enqueue(text, jsonb, jsonb) TO helpos_app;
`;
