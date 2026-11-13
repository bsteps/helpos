import type {
  JobRunner,
  RetryPolicy,
  TenantJob,
  TenantJobHandler,
  TenantStepsHandler,
} from "@helpos/db";
import { handleDraftGaveUp, handleDraftReply } from "./drafts/draft-worker.ts";
import { draftNoticeJob, draftReplyJob, sendReplyJob } from "./drafts/jobs.ts";
import { handleDraftNotice, handleNoticeGaveUp } from "./drafts/notice-worker.ts";
import { handleSendGaveUp, handleSendReply } from "./drafts/send-worker.ts";
import { handleIngestGaveUp, handleIngestSource } from "./knowledge/ingest-worker.ts";
import { ingestSourceJob } from "./knowledge/jobs.ts";
import { createVectorSearch } from "./knowledge/search.ts";
import type { ServerConfig, Services } from "./services.ts";

// Every background job, declared once: its queue, how it's retried, what runs it and what
// marks it failed for good. The worker works these, and every queue is created from this
// list (worker, seed, tests), so a job can't be enqueued to a queue nobody created.
// The queue definitions themselves live in each feature's jobs.ts, because the code that
// enqueues a job must not import its handler.

type Run<P> = { transaction: TenantJobHandler<P> } | { steps: TenantStepsHandler<P> };

/** Why a job's work waits in the queue: something it needs isn't configured. */
type Waits = { waits: string };

interface JobSpec<P extends { tenantId: string }> {
  job: TenantJob<P>;
  retry: RetryPolicy;
  /** Builds the handler from the shared services, or says why its jobs wait in the queue. */
  run(services: Services): Run<P> | Waits;
  /**
   * Required: runs once after the last retry failed, in its own transaction, and leaves a
   * state people can see (a marked conversation or source) and an audit event. Without it, a job
   * that keeps failing would leave its work silently undone.
   */
  onGiveUp: TenantJobHandler<P>;
}

/** A registered job, with its payload type sealed inside. */
export interface Job {
  readonly queue: string;
  ensureQueue(runner: Pick<JobRunner, "ensureQueue">, config: JobQueueConfig): Promise<void>;
  /** Starts working the queue, or returns why its jobs wait. */
  start(runner: JobRunner, services: Services): Promise<Waits | undefined>;
}

type JobQueueConfig = Pick<ServerConfig, "jobRetry">;

function defineJob<P extends { tenantId: string }>(spec: JobSpec<P>): Job {
  return {
    queue: spec.job.queue,
    ensureQueue: (runner, config) => runner.ensureQueue(spec.job, config.jobRetry ?? spec.retry),
    start: async (runner, services) => {
      const run = spec.run(services);
      if ("waits" in run) return run;
      const { logger } = services;
      const queue = spec.job.queue;
      const onGiveUp: TenantJobHandler<P> = async (payload, tx) => {
        logger.error({ queue }, "job failed on its last retry: marked as failed");
        await spec.onGiveUp(payload, tx);
      };
      /** A failed attempt is logged, then rethrown so pg-boss retries it (or gives up). */
      const logged =
        <C, R>(handler: (payload: P, context: C) => Promise<R>) =>
        async (payload: P, context: C) => {
          try {
            return await handler(payload, context);
          } catch (error) {
            logger.error({ err: error, queue }, "job attempt failed");
            throw error;
          }
        };
      await runner.work(
        spec.job,
        "steps" in run
          ? { steps: logged(run.steps), onGiveUp }
          : { transaction: logged(run.transaction), onGiveUp },
      );
      return undefined;
    },
  };
}

/**
 * A failed send is tried 8 more times, 1 minute apart at first and doubling up to an hour:
 * about 3 hours in all, enough to ride out a mail server outage. After that the draft is
 * marked `send_failed`, for someone to retry or discard.
 */
const sendReplyRetry: RetryPolicy = {
  limit: 8,
  delaySeconds: 60,
  backoff: true,
  maxDelaySeconds: 3600,
};

export const jobs: readonly Job[] = [
  defineJob({
    job: draftReplyJob,
    // A model outage of a few minutes. After that the conversation is marked `draft_failed`, and a
    // person can ask the AI again from the dashboard.
    retry: { limit: 3, delaySeconds: 30, backoff: true, maxDelaySeconds: 300 },
    run: (s) =>
      s.model
        ? {
            steps: handleDraftReply({
              ...s,
              model: s.model,
              search: s.embeddingModel ? createVectorSearch(s.embeddingModel) : undefined,
            }),
          }
        : { waits: "AI is not configured: draft-reply jobs will wait in the queue" },
    onGiveUp: handleDraftGaveUp,
  }),
  defineJob({
    job: sendReplyJob,
    retry: sendReplyRetry,
    run: (s) =>
      s.transport
        ? { steps: handleSendReply({ ...s, transport: s.transport }) }
        : { waits: "HELPOS_SMTP_URL is not set: approved replies will wait in the queue" },
    onGiveUp: handleSendGaveUp,
  }),
  defineJob({
    job: draftNoticeJob,
    retry: { limit: 3, delaySeconds: 60, backoff: true, maxDelaySeconds: 600 },
    run: (s) => {
      const { transport, auth } = s;
      if (!transport || !auth) {
        return {
          waits:
            "HELPOS_SMTP_URL or HELPOS_DATABASE_AUTH_URL is not set: draft notices will wait in the queue",
        };
      }
      // Only the one function notices need, not the whole auth store.
      const emailsOf = (ids: string[]) => auth.emailsOf(ids);
      return { transaction: handleDraftNotice({ ...s, transport, auth: { emailsOf } }) };
    },
    onGiveUp: handleNoticeGaveUp,
  }),
  defineJob({
    job: ingestSourceJob,
    // The handler throws only on database errors; it marks the source itself for the rest.
    retry: { limit: 3, delaySeconds: 30, backoff: true, maxDelaySeconds: 300 },
    run: (s) =>
      s.embeddingModel
        ? { steps: handleIngestSource({ ...s, embeddingModel: s.embeddingModel }) }
        : {
            waits:
              "AI embeddings are not configured: knowledge sources will wait in the queue, and drafts use no knowledge",
          },
    onGiveUp: handleIngestGaveUp,
  }),
];

/**
 * Creates every job queue, with its retry policy. enqueue() refuses a queue that doesn't exist,
 * so anything that enqueues before a worker has started (the seed, tests) calls this first.
 */
export async function ensureJobQueues(
  runner: Pick<JobRunner, "ensureQueue">,
  config: JobQueueConfig,
): Promise<void> {
  for (const job of jobs) await job.ensureQueue(runner, config);
}
