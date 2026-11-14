import {
  type EmbeddingModel,
  EmbedError,
  embeddingModelId,
  embedTexts,
  isTemporaryAiFailure,
  tokenBound,
} from "@helpos/ai";
import { eq, type JobDeferral, schema, type TenantTransaction, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import { aiBudget, mapAiRefusal, nextUtcDay } from "../ai-budget/budget.ts";
import type { Clock, ServerConfig } from "../services.ts";
import { chunkText, maxChunks } from "./chunk.ts";
import { tidyAuthored } from "./extract.ts";
import { type Fetcher, fetchPageText, type PageText } from "./page-fetch.ts";
import {
  failIngest,
  type IngestJob,
  lockIfCurrent,
  storeIngested,
  waitToIngest,
} from "./source-lifecycle.ts";

const { knowledgeSources } = schema;

export interface IngestWorkerDeps {
  embeddingModel: EmbeddingModel;
  fetch: Fetcher;
  logger: Pick<Logger, "info" | "warn">;
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget" | "fetchRetryDelaysMs">;
  shutdown?: AbortSignal | undefined;
}

function isTemporary(
  reason: schema.KnowledgeFailureReason,
): reason is schema.KnowledgeWaitReason & schema.KnowledgeFailureReason {
  return (
    reason.code === "timeout" ||
    reason.code === "network" ||
    reason.code === "embedding_unavailable" ||
    (reason.code === "http_error" && [408, 425, 429, 500, 502, 503, 504].includes(reason.status))
  );
}

export const retryDelayMs = 15 * 60_000;

async function fetchWithRetries(deps: IngestWorkerDeps, url: string): Promise<PageText> {
  let page = await fetchPageText(deps, url);
  for (const delay of deps.config.fetchRetryDelaysMs) {
    if (page.ok || !isTemporary(page.reason) || page.reason.code === "timeout") return page;
    await new Promise((done) => setTimeout(done, delay));
    page = await fetchPageText(deps, url);
  }
  return page;
}

function vectorAt(embeddings: number[][], position: number): number[] {
  const vector = embeddings[position];
  if (!vector) throw new Error(`ingest: no vector for chunk ${position}`);
  return vector;
}

export async function handleIngestGaveUp(payload: IngestJob, tx: TenantTx): Promise<void> {
  await failIngest(tx, payload, { code: "ingest_error" });
}

export function handleIngestSource(deps: IngestWorkerDeps) {
  const budget = aiBudget(deps);
  return async (
    payload: { tenantId: string; sourceId: string },
    transaction: TenantTransaction,
  ) => {
    const { tenantId, sourceId } = payload;
    const now = () => deps.clock.now();
    const [source] = await transaction((tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId)),
    );
    if (!source) return; // deleted before the job ran
    if (source.state.status !== "pending" && source.state.status !== "waiting") return;
    // Every request to ingest it again counts up. If one comes in while this run is fetching,
    // the result is from before it: see `lockIfCurrent`.
    const job: IngestJob = { tenantId, sourceId, requests: source.ingestRequests };

    const fail = (reason: schema.KnowledgeFailureReason) =>
      transaction(async (tx) => {
        if ((await failIngest(tx, job, reason)) === "written") {
          deps.logger.warn({ sourceId, reason }, "knowledge source could not be ingested");
        }
      });

    const started = now();

    const waitUntil = (
      reason: schema.KnowledgeWaitReason,
      startAfter: Date,
      kind: "retry" | "budget",
      retryCount = source.retryCount,
    ) =>
      transaction(async (tx) => {
        if ((await waitToIngest(tx, job, { reason, startAfter, kind, retryCount })) === "written") {
          deps.logger.warn({ sourceId, reason, startAfter }, "knowledge source waits to run again");
        }
      });

    // A temporary problem gets one more try, 15 minutes later. A source already waiting on one
    // fails if any temporary problem happens again, the site's or the provider's: one shared
    // try, so a source that meets one and then the other can't take turns waiting forever.
    const waitedOnce = source.retryCount > 0;
    const retryLater = (reason: schema.KnowledgeWaitReason) => {
      const retryAt = new Date(started.getTime() + retryDelayMs);
      return waitUntil(reason, retryAt, "retry", source.retryCount + 1);
    };
    const waitForBudget = (resetsAt: Date) =>
      waitUntil({ code: "daily_budget_reached" }, resetsAt, "budget");
    // Checked before the fetch too, so a source that must wait doesn't fetch its page twice.
    // The reservation below is what holds the cap.
    const today = await transaction((tx) => budget.today(tx, tenantId));
    if (today.paused) return waitForBudget(nextUtcDay(new Date(today.day)));

    let chunks: string[];
    try {
      let page: PageText;
      if (source.kind === "url") {
        page = source.url
          ? await fetchWithRetries(deps, source.url)
          : { ok: false, reason: { code: "no_url" } };
      } else {
        page = { ok: true, text: tidyAuthored(source.content ?? "") };
      }
      if (!page.ok) {
        if (isTemporary(page.reason) && !waitedOnce) return retryLater(page.reason);
        return fail(page.reason);
      }
      // Stops early on a huge page: past the limit, it fails anyway.
      chunks = chunkText(page.text, maxChunks);
    } catch (error) {
      // Reading the page broke (a bug, or a page no parser expects). A retry would break the
      // same way, and then the source would stay `pending` with no job: it fails instead.
      deps.logger.warn({ err: error, sourceId }, "reading the page failed");
      return fail({ code: "ingest_error" });
    }
    if (chunks.length === 0) return fail({ code: "no_text" });
    if (chunks.length > maxChunks) return fail({ code: "too_long" });

    const reservation = await transaction((tx) =>
      budget.reserve(tx, tenantId, tokenBound(...chunks)),
    );
    if ("refused" in reservation) {
      return mapAiRefusal<Promise<JobDeferral | undefined>>(reservation, {
        busy: async (deferUntil) => {
          const current = await transaction((tx) => lockIfCurrent(tx, job));
          if (current) return { deferUntil };
        },
        over_budget: async (retryAt) => {
          await waitForBudget(retryAt);
        },
      });
    }

    let embedded: Awaited<ReturnType<typeof embedTexts>>;
    try {
      embedded = await budget.spend(
        transaction,
        reservation,
        (_signal, models) => embedTexts(models(deps.embeddingModel), chunks),
        {
          of: (result) => ({ inputTokens: result.tokens, outputTokens: 0 }),
          // Includes earlier spend and the failed batch bound: its bill may be unknown.
          ofFailure: (error) => ({
            inputTokens: error instanceof EmbedError ? error.tokens : 0,
            outputTokens: 0,
          }),
        },
      );
    } catch (error) {
      // The server is shutting down: the job is tried again once it's back, source untouched.
      if (deps.shutdown?.aborted) throw error;
      deps.logger.warn({ err: error, sourceId }, "embedding failed");
      // The provider is down or rate-limited: try again later, once. A wrong key or a broken
      // model would end the same way every time, so that fails at once.
      if (!isTemporaryAiFailure(error)) return fail({ code: "embedding_failed" });
      return waitedOnce
        ? fail({ code: "embedding_unavailable" })
        : retryLater({ code: "embedding_unavailable" });
    }
    const { embeddings } = embedded;
    const modelId = embeddingModelId(deps.embeddingModel);
    if (embeddings.length !== chunks.length) {
      // A broken server. Retrying would pay again for the same answer.
      deps.logger.warn(
        { sourceId, embeddings: embeddings.length, chunks: chunks.length },
        "embedding server returned the wrong number of vectors",
      );
      return fail({ code: "embedding_failed" });
    }

    const passages = chunks.map((content, position) => ({
      content,
      embedding: vectorAt(embeddings, position),
    }));
    await transaction(async (tx) => {
      if ((await storeIngested(tx, job, { passages, model: modelId, at: now() })) === "written") {
        deps.logger.info({ sourceId, chunks: chunks.length }, "knowledge source ingested");
      }
    });
  };
}
