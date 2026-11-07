import type { LanguageModel } from "@helpos/ai";
import type { AuthStore, JobRunner, TenantJobHandler } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import type { Logger } from "pino";
import { errorSummary } from "./app.ts";
import { handleDraftReply } from "./drafts/draft-worker.ts";
import { draftNoticeJob, draftReplyJob, sendReplyJob } from "./drafts/jobs.ts";
import { handleDraftNotice } from "./drafts/notice-worker.ts";
import { handleSendReply } from "./drafts/send-worker.ts";
import type { EmailTransport } from "./outbound-email/transport.ts";

export interface WorkerDeps {
  runner: JobRunner;
  files: FileStore;
  logger: Pick<Logger, "error" | "warn" | "info">;
  /** Without a model, draft jobs wait in the queue. */
  model: LanguageModel | undefined;
  /** Tokens per workspace per UTC day. */
  dailyTokenBudget: number;
  now?: () => Date;
  /** Without a transport, approved drafts wait in the queue. */
  transport: EmailTransport | undefined;
  /** Reads owner emails for draft notices. Without it, notices wait in the queue. */
  auth: Pick<AuthStore, "emailsOf"> | undefined;
  /** Base URL for links in notices. */
  publicUrl: string;
}

/**
 * The worker role. Inside the server process for the MVP (#18 splits it out). Queues are
 * always created, so the API can enqueue even when a worker is switched off.
 */
export async function startWorker(deps: WorkerDeps): Promise<void> {
  const { runner, logger } = deps;
  await runner.ensureQueue(draftReplyJob);
  await runner.ensureQueue(sendReplyJob);
  await runner.ensureQueue(draftNoticeJob);

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
  if (deps.transport && deps.auth) {
    await runner.work(
      draftNoticeJob,
      logged(
        "draft-notice",
        handleDraftNotice({ ...deps, transport: deps.transport, auth: deps.auth }),
      ),
    );
  } else {
    logger.warn(
      "HELPOS_SMTP_URL or HELPOS_DATABASE_AUTH_URL is not set: draft notices will wait in the queue",
    );
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
