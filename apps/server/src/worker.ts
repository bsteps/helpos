import type { EmbeddingModel, LanguageModel } from "@helpos/ai";
import type { AuthStore, JobRunner } from "@helpos/db";
import type { FileStore } from "@helpos/files";
import { safeFetch } from "@helpos/safe-fetch";
import type { Logger } from "pino";
import { errorSummary } from "./app.ts";
import { handleDraftReply } from "./drafts/draft-worker.ts";
import { draftNoticeJob, draftReplyJob, sendReplyJob } from "./drafts/jobs.ts";
import { handleDraftNotice } from "./drafts/notice-worker.ts";
import { handleSendReply } from "./drafts/send-worker.ts";
import { type Fetcher, handleIngestSource } from "./knowledge/ingest-worker.ts";
import { ingestSourceJob } from "./knowledge/jobs.ts";
import { createVectorSearch } from "./knowledge/search.ts";
import type { EmailTransport } from "./outbound-email/transport.ts";

export interface WorkerDeps {
  runner: JobRunner;
  files: FileStore;
  logger: Pick<Logger, "error" | "warn" | "info">;
  /** Without a model, draft jobs wait in the queue. */
  model: LanguageModel | undefined;
  /** Without one, knowledge ingest jobs wait in the queue and drafts use no knowledge. */
  embeddingModel: EmbeddingModel | undefined;
  /** For tests only. Every knowledge URL is fetched through the SSRF-safe fetch. */
  fetch?: Fetcher;
  /** Tokens per workspace per UTC day. */
  dailyTokenBudget: number;
  now?: () => Date;
  /** Without a transport, approved drafts wait in the queue. */
  transport: EmailTransport | undefined;
  /** Reads owner emails for draft notices. Without it, notices wait in the queue. */
  auth: Pick<AuthStore, "emailsOf"> | undefined;
  /** Base URL for links in notices. */
  publicUrl: string;
  /** How long a new draft waits before its owner notice is sent. */
  noticeDelaySeconds?: number;
}

/**
 * The worker role. Inside the server process for the MVP (#18 splits it out). Queues are
 * always created, so the API can enqueue even when a worker is switched off.
 */
export async function startWorker(deps: WorkerDeps): Promise<void> {
  const { runner, logger } = deps;
  await runner.ensureQueue(draftReplyJob);
  await runner.ensureQueue(sendReplyJob);
  await runner.ensureQueue(ingestSourceJob);
  await runner.ensureQueue(draftNoticeJob);

  const search = deps.embeddingModel ? createVectorSearch(deps.embeddingModel) : undefined;
  if (deps.model) {
    await runner.workInSteps(
      draftReplyJob,
      logged("draft-reply", handleDraftReply({ ...deps, model: deps.model, search })),
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
  if (deps.embeddingModel) {
    await runner.workInSteps(
      ingestSourceJob,
      logged(
        "ingest-source",
        handleIngestSource({
          ...deps,
          embeddingModel: deps.embeddingModel,
          fetch: deps.fetch ?? safeFetch,
        }),
      ),
    );
  } else {
    logger.warn(
      "AI embeddings are not configured: knowledge sources will wait in the queue, and drafts use no knowledge",
    );
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
  function logged<P, C>(
    queue: string,
    handler: (payload: P, context: C) => Promise<void>,
  ): (payload: P, context: C) => Promise<void> {
    return async (payload, context) => {
      try {
        await handler(payload, context);
      } catch (error) {
        logger.error({ err: errorSummary(error), queue }, "job failed, will retry");
        throw error;
      }
    };
  }
}
