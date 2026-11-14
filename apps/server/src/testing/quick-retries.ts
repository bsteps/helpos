import type { JobRunner, RetryPolicy } from "@helpos/db";
import { jobs } from "../jobs.ts";

export async function retryJobsQuickly(
  runner: Pick<JobRunner, "ensureQueue">,
  retry: RetryPolicy = { limit: 1, delaySeconds: 1, backoff: false },
): Promise<void> {
  for (const { job } of jobs) await runner.ensureQueue(job, retry);
}
