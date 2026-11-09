import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { z } from "zod";
import type { Database, TenantTx } from "./client.ts";

// Background jobs. pg-boss runs as the `jobs` role and owns the
// `pgboss` schema. The app role can only enqueue, through jobs_api.app_enqueue(), and handlers
// only ever see one tenant's data, through withTenant().

const PGBOSS_SCHEMA = "pgboss";
const SYSTEM_PREFIX = "system.";
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

/** A queue with no tenant, e.g. cleanup. Its handler gets no tenant client. */
export interface SystemJob<P> {
  kind: "system";
  queue: string;
  payload: z.ZodType<P>;
}

/**
 * Defines a tenant job. Payloads carry IDs only, never tenant content: the handler
 * reloads data inside withTenant(), so nothing lingers in job history. `tenantId` is always added.
 */
export function defineTenantJob<const K extends string>(
  queue: string,
  ids: Record<K, z.ZodUUID>,
): TenantJob<{ tenantId: string } & Record<K, string>> {
  const name = queueNameSchema.parse(queue);
  if (name.startsWith(SYSTEM_PREFIX)) throw new Error(`tenant queue cannot use "${SYSTEM_PREFIX}"`);
  const shape: Record<string, z.ZodUUID> = { ...ids, tenantId: z.uuid() };
  // The shape is all UUIDs by construction, so the parsed object has exactly this type.
  const payload = z.strictObject(shape) as unknown as z.ZodType<
    { tenantId: string } & Record<K, string>
  >;
  return { kind: "tenant", queue: name, payload };
}

export function defineSystemJob<P>(queue: string, payload: z.ZodType<P>): SystemJob<P> {
  const name = queueNameSchema.parse(`${SYSTEM_PREFIX}${queue}`);
  return { kind: "system", queue: name, payload };
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
export type SystemJobHandler<P> = (payload: P) => Promise<void>;

/** Opens one transaction as the job's tenant: every query in it goes through withTenant(). */
export type TenantTransaction = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
/**
 * For a job that waits on the network, such as a page fetch or a model call. It opens short
 * transactions around the wait instead of holding one (and its pooled connection and row
 * locks) for the whole job. It still only ever sees its own tenant's data.
 */
export type TenantStepsHandler<P> = (payload: P, transaction: TenantTransaction) => Promise<void>;

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

export interface TenantWorkOptions<P> {
  /**
   * Runs once, in its own transaction, after the last attempt failed (the attempt's own
   * transaction has rolled back). For marking the work as failed for good, so it isn't lost
   * silently. The job still ends up failed in pg-boss.
   */
  onGiveUp?: TenantJobHandler<P>;
}

export interface JobRunner {
  /** Starts pg-boss. Call installJobs() first (migrate step). */
  start(): Promise<void>;
  /**
   * Creates the queue if needed, and sets its retry policy when given. enqueue() refuses a
   * queue that doesn't exist yet.
   */
  ensureQueue(
    job: TenantJob<{ tenantId: string }> | SystemJob<unknown>,
    retry?: RetryPolicy,
  ): Promise<void>;
  /** Creates the queue if needed and starts working it. */
  work<P extends { tenantId: string }>(
    job: TenantJob<P>,
    handler: TenantJobHandler<P>,
    options?: TenantWorkOptions<P>,
  ): Promise<void>;
  work<P>(job: SystemJob<P>, handler: SystemJobHandler<P>): Promise<void>;
  /** Like work(), for a handler that opens its own transactions between network calls. */
  workInSteps<P extends { tenantId: string }>(
    job: TenantJob<P>,
    handler: TenantStepsHandler<P>,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface JobRunnerOptions {
  /** URL for the jobs role (owner of `pgboss`). */
  jobsUrl: string;
  /** App-role database. Tenant handlers reach data only through its withTenant(). */
  db: Database;
  /** pg-boss reports background errors here. Without a listener they would crash the process. */
  onError: (error: unknown) => void;
  pollingIntervalSeconds?: number;
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
    job: TenantJob<{ tenantId: string }> | SystemJob<unknown>,
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

  async function consume<P>(
    job: TenantJob<{ tenantId: string }> | SystemJob<unknown>,
    run: (payload: P) => Promise<void>,
    onLastFailure?: (payload: P) => Promise<void>,
  ): Promise<void> {
    await boss.createQueue(job.queue);
    // With metadata, to tell the last attempt from one that will be retried.
    const workOptions = { batchSize: 1, pollingIntervalSeconds, includeMetadata: true } as const;
    await boss.work<unknown, unknown, typeof workOptions>(job.queue, workOptions, async (jobs) => {
      for (const { data, retryCount, retryLimit } of jobs) {
        // Re-validate: the row came from a table, and a bad payload must fail, not guess.
        const payload = job.payload.parse(data) as P;
        try {
          await run(payload);
        } catch (error) {
          if (onLastFailure && retryCount >= retryLimit) {
            // Reported, not thrown: the job's own error is the one pg-boss should record.
            await onLastFailure(payload).catch(options.onError);
          }
          throw error;
        }
      }
    });
  }

  async function work(
    job: TenantJob<{ tenantId: string }> | SystemJob<unknown>,
    handler: TenantJobHandler<{ tenantId: string }> | SystemJobHandler<unknown>,
    workOptions: TenantWorkOptions<{ tenantId: string }> = {},
  ): Promise<void> {
    if (job.kind === "system") {
      await consume(job, handler as SystemJobHandler<unknown>);
      return;
    }
    const tenantHandler = handler as TenantJobHandler<{ tenantId: string }>;
    const { onGiveUp } = workOptions;
    await consume<{ tenantId: string }>(
      job,
      (payload) => options.db.withTenant(payload.tenantId, (tx) => tenantHandler(payload, tx)),
      onGiveUp &&
        ((payload) => options.db.withTenant(payload.tenantId, (tx) => onGiveUp(payload, tx))),
    );
  }

  async function workInSteps<P extends { tenantId: string }>(
    job: TenantJob<P>,
    handler: TenantStepsHandler<P>,
  ): Promise<void> {
    await consume<P>(job, (payload) =>
      handler(payload, tenantTransactions(options.db, payload.tenantId)),
    );
  }

  return {
    ensureQueue,
    start: async () => {
      await boss.start();
    },
    work: work as JobRunner["work"],
    workInSteps,
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
  IF p_queue IS NULL OR p_queue LIKE 'system.%' THEN
    RAISE EXCEPTION 'app_enqueue: only tenant queues' USING ERRCODE = '42501';
  END IF;
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
