import type { JobRunner } from "@helpos/db";
import { ensureJobQueues, jobs } from "./jobs.ts";
import type { Services } from "./services.ts";

/**
 * The worker role. Inside the server process for the MVP (#18 splits it out). Every queue is
 * created first, so the API can enqueue even when a job's worker is switched off (its jobs
 * then wait in the queue until what it needs is configured).
 */
export async function startWorker(services: Services, runner: JobRunner): Promise<void> {
  await ensureJobQueues(runner);
  for (const job of jobs) {
    const waiting = await job.start(runner, services);
    if (waiting) services.logger.warn(waiting.waits);
  }
}
