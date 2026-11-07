import type { LanguageModel } from "@helpos/ai";
import type { JobRunner, TenantJobHandler } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import type { Logger } from "pino";
import { errorSummary } from "./app.ts";
import { handleDraftReply } from "./drafts/draft-worker.ts";
import { draftReplyJob, sendReplyJob } from "./drafts/jobs.ts";
import { handleSendReply } from "./drafts/send-worker.ts";
import type { EmailTransport } from "./outbound-email/transport.ts";

export interface WorkerDeps {
  runner: JobRunner;
  files: FileStore;
  logger: Pick<Logger, "error" | "warn" | "info">;
  /** Without a model, draft jobs wait in the queue. */
  model: LanguageModel | undefined;
  /** Without a transport, approved drafts wait in the queue. */
  transport: EmailTransport | undefined;
}

/**
 * The worker role. Inside the server process for the MVP (#18 splits it out). Queues are
 * always created, so the API can enqueue even when a worker is switched off.
 */
export async function startWorker(deps: WorkerDeps): Promise<void> {
  const { runner, logger } = deps;
  await runner.ensureQueue(draftReplyJob);
  await runner.ensureQueue(sendReplyJob);

  if (deps.model) {
    await runner.work(
      draftReplyJob,
      logged("draft-reply", handleDraftReply({ ...deps, model: deps.model })),
    );
  } else {
    logger.warn("AI is not configured: draft-reply jobs will wait in the queue");
  }
  if (deps.transport) {
    await runner.work(
      sendReplyJob,
      logged("send-reply", handleSendReply({ ...deps, transport: deps.transport })),
    );
  } else {
    logger.warn("HELPOS_SMTP_URL is not set: approved replies will wait in the queue");
  }

  /** A failed job is logged, then rethrown so pg-boss retries it. Never dropped silently. */
  function logged<P>(queue: string, handler: TenantJobHandler<P>): TenantJobHandler<P> {
    return async (payload, tx) => {
      try {
        await handler(payload, tx);
      } catch (error) {
        logger.error({ err: errorSummary(error), queue }, "job failed, will retry");
        throw error;
      }
    };
  }
}
