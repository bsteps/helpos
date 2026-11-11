import {
  type EmbeddingModel,
  EmbedError,
  embeddingModelId,
  embedTexts,
  isTemporaryAiFailure,
  tokenBound,
} from "@helpos/ai";
import { enqueue, eq, schema, type TenantTransaction, type TenantTx } from "@helpos/db";
import type { Logger } from "pino";
import { AiBusyError, aiBudget, nextUtcDay } from "../ai-budget/budget.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Clock, ServerConfig } from "../services.ts";
import { chunkText, maxChunks } from "./chunk.ts";
import { tidyAuthored } from "./extract.ts";
import { ingestSourceJob } from "./jobs.ts";
import { type Fetcher, fetchPageText, type PageText } from "./page-fetch.ts";

const { knowledgeChunks, knowledgeSources } = schema;

export interface IngestWorkerDeps {
  embeddingModel: EmbeddingModel;
  fetch: Fetcher;
  logger: Pick<Logger, "info" | "warn">;
  clock: Clock;
  config: Pick<ServerConfig, "dailyTokenBudget" | "fetchRetryDelaysMs">;
  shutdown?: AbortSignal | undefined;
}

const ingestActor = { type: "system", id: "ingest-source" } as const;

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

function supersedes(reason: schema.KnowledgeFailureReason): boolean {
  return reason.code === "http_error"
    ? [404, 410, 451].includes(reason.status)
    : ["no_text", "too_long", "too_large", "unsupported_content_type"].includes(reason.code);
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

export async function handleIngestGaveUp(
  payload: { tenantId: string; sourceId: string; requests: number },
  tx: TenantTx,
): Promise<void> {
  const { tenantId, sourceId, requests } = payload;
  const [source] = await tx
    .select({ state: knowledgeSources.state, requests: knowledgeSources.ingestRequests })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .for("update");
  if (!source || (source.state.status !== "pending" && source.state.status !== "waiting")) return;
  if (source.requests !== requests) {
    await enqueue(tx, ingestSourceJob, { tenantId, sourceId, requests: source.requests });
    return;
  }
  await tx
    .update(knowledgeSources)
    .set({ state: { status: "failed", reason: { code: "ingest_error" } } })
    .where(eq(knowledgeSources.id, sourceId));
  await recordAudit(tx, {
    tenantId,
    actor: ingestActor,
    action: "knowledge_source.failed",
    target: { type: "knowledge_source", id: sourceId },
    requestId: null,
  });
}

export function handleIngestSource(deps: IngestWorkerDeps) {
  const budget = aiBudget(deps);
  return async (
    payload: { tenantId: string; sourceId: string },
    transaction: TenantTransaction,
  ): Promise<void> => {
    const { tenantId, sourceId } = payload;
    const now = () => deps.clock.now();
    const [source] = await transaction((tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId)),
    );
    if (!source) return; // deleted before the job ran
    if (source.state.status !== "pending" && source.state.status !== "waiting") return;
    // Every request to ingest it again counts up. If one comes in while this run is fetching,
    // the result is from before it: see `lockIfCurrent`.
    const requests = source.ingestRequests;

    const lockIfCurrent = async (tx: TenantTx): Promise<boolean> => {
      const [current] = await tx
        .select({ state: knowledgeSources.state, requests: knowledgeSources.ingestRequests })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, sourceId))
        .for("update");
      if (!current || (current.state.status !== "pending" && current.state.status !== "waiting"))
        return false;
      if (current.requests === requests) return true;
      await enqueue(tx, ingestSourceJob, { tenantId, sourceId, requests: current.requests });
      return false;
    };

    const fail = (reason: schema.KnowledgeFailureReason) =>
      transaction(async (tx) => {
        if (!(await lockIfCurrent(tx))) return;
        const gone = supersedes(reason);
        if (gone) await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
        await tx
          .update(knowledgeSources)
          .set({
            state: { status: "failed", reason },
            ...(gone ? { chunkCount: 0, embeddingModel: null } : {}),
          })
          .where(eq(knowledgeSources.id, sourceId));
        await recordAudit(tx, {
          tenantId,
          actor: ingestActor,
          action: "knowledge_source.failed",
          target: { type: "knowledge_source", id: sourceId },
          requestId: null,
        });
        deps.logger.warn({ sourceId, reason }, "knowledge source could not be ingested");
      });

    const started = now();

    const waitUntil = (
      reason: schema.KnowledgeWaitReason,
      startAfter: Date,
      singletonKey: string,
      retryCount = source.retryCount,
    ) =>
      transaction(async (tx) => {
        if (!(await lockIfCurrent(tx))) return;
        await tx
          .update(knowledgeSources)
          .set({
            state: { status: "waiting", reason, retryAt: startAfter.toISOString() },
            retryCount,
          })
          .where(eq(knowledgeSources.id, sourceId));
        await enqueue(
          tx,
          ingestSourceJob,
          { tenantId, sourceId, requests },
          { singletonKey, startAfter },
        );
        deps.logger.warn({ sourceId, reason, startAfter }, "knowledge source waits to run again");
      });

    // A temporary problem gets one more try, 15 minutes later. A source already waiting on one
    // fails if any temporary problem happens again, the site's or the provider's: one shared
    // try, so a source that meets one and then the other can't take turns waiting forever.
    const waitedOnce = source.retryCount > 0;
    const retryLater = (reason: schema.KnowledgeWaitReason) => {
      const retryAt = new Date(started.getTime() + retryDelayMs);
      return waitUntil(
        reason,
        retryAt,
        `${sourceId}:retry:${retryAt.toISOString()}`,
        source.retryCount + 1,
      );
    };
    const waitForBudget = (resetsAt: Date) =>
      waitUntil(
        { code: "daily_budget_reached" },
        resetsAt,
        `${sourceId}:after:${resetsAt.toISOString()}`,
      );
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
    // Other calls in flight hold the rest of today's budget: pg-boss tries again shortly.
    if (reservation === "busy") throw new AiBusyError();
    if ("refused" in reservation) return waitForBudget(reservation.resetsAt);

    let embedded: Awaited<ReturnType<typeof embedTexts>>;
    try {
      embedded = await budget.spend(
        transaction,
        reservation,
        (signal) => embedTexts(deps.embeddingModel, chunks, { abortSignal: signal }),
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

    await transaction(async (tx) => {
      if (!(await lockIfCurrent(tx))) return;
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
      await tx.insert(knowledgeChunks).values(
        chunks.map((content, position) => ({
          tenantId,
          sourceId,
          position,
          content,
          embedding: vectorAt(embeddings, position),
          embeddingModel: modelId,
        })),
      );
      await tx
        .update(knowledgeSources)
        .set({
          state: { status: "ready" },
          retryCount: 0,
          chunkCount: chunks.length,
          ingestedAt: now(),
          embeddingModel: modelId,
        })
        .where(eq(knowledgeSources.id, sourceId));
      await recordAudit(tx, {
        tenantId,
        actor: ingestActor,
        action: "knowledge_source.ingested",
        target: { type: "knowledge_source", id: sourceId },
        requestId: null,
      });
      deps.logger.info({ sourceId, chunks: chunks.length }, "knowledge source ingested");
    });
  };
}
