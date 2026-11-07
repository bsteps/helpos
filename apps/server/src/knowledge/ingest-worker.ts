import { type EmbeddingModel, embeddingModelId, embedTexts } from "@helpos/ai";
import { eq, schema, type TenantTx } from "@helpos/db";
import { SafeFetchError, type safeFetch } from "@helpos/safe-fetch";
import type { Logger } from "pino";
import { lockUsage, recordUsage, totalTokens, utcDay } from "../ai-budget/budget.ts";
import { errorSummary } from "../app.ts";
import { recordAudit } from "../audit/audit.ts";
import { chunkText } from "./chunk.ts";
import { extractHtml, tidy } from "./extract.ts";

const { knowledgeChunks, knowledgeSources } = schema;

/** The SSRF-safe fetch (ADR 0004). A parameter only so tests can reach a local test server. */
export type Fetcher = typeof safeFetch;

export interface IngestWorkerDeps {
  embeddingModel: EmbeddingModel;
  fetch: Fetcher;
  logger: Pick<Logger, "info" | "warn">;
  /** Embedding tokens count toward the same daily budget as drafting. */
  dailyTokenBudget: number;
  now?: () => Date;
}

export const ingestActor = { type: "system", id: "ingest-source" } as const;

/** A help-center page is far smaller; anything bigger is not an article. */
export const maxPageBytes = 2 * 1024 * 1024;
const fetchTimeoutMs = 15_000;

type PageText = { ok: true; text: string } | { ok: false; error: string };

const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

/** Fetches one page through the SSRF-safe fetch and returns its text, or why it couldn't. */
async function fetchPageText(deps: IngestWorkerDeps, url: string): Promise<PageText> {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await deps.fetch(url, {
      maxBytes: maxPageBytes,
      timeoutMs: fetchTimeoutMs,
      headers: { accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8" },
      logger: deps.logger,
    });
  } catch (error) {
    // A blocked or failed fetch is the source's problem, not a reason to retry the job.
    if (error instanceof SafeFetchError) return { ok: false, error: error.code };
    throw error;
  }
  if (res.status < 200 || res.status > 299) return { ok: false, error: `http_${res.status}` };

  const [mediaType = "", ...params] = String(res.headers["content-type"] ?? "")
    .toLowerCase()
    .split(";")
    .map((p) => p.trim());
  const isHtml = htmlTypes.has(mediaType);
  if (!isHtml && !textTypes.has(mediaType)) return { ok: false, error: "unsupported_content_type" };

  const charset = params.find((p) => p.startsWith("charset="))?.slice(8) ?? "utf-8";
  let body: string;
  try {
    body = new TextDecoder(charset).decode(res.body);
  } catch {
    // An unknown charset label: UTF-8 is the web's default and usually right.
    body = new TextDecoder("utf-8").decode(res.body);
  }
  return { ok: true, text: isHtml ? extractHtml(body).text : tidy(body) };
}

/**
 * Turns one knowledge source into embedded chunks. A source that can't be used (blocked URL,
 * 404, no text, budget spent, embedding call failed) is marked `failed` with a short reason,
 * and the job ends without a retry, so a source never stays `pending` after its job is done.
 * Only database errors throw, and pg-boss retries those. When a re-ingest fails, the chunks
 * from the last good ingest stay in use, so a flaky site doesn't empty the knowledge base.
 */
export function handleIngestSource(deps: IngestWorkerDeps) {
  return async (payload: { tenantId: string; sourceId: string }, tx: TenantTx): Promise<void> => {
    const { tenantId, sourceId } = payload;
    // Locked, so a delete waits for this job instead of racing the chunk inserts.
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, sourceId))
      .for("update");
    if (!source) return; // deleted before the job ran
    if (source.status !== "pending") return; // a retry after the work was done

    const fail = async (error: string) => {
      await tx
        .update(knowledgeSources)
        .set({ status: "failed", error })
        .where(eq(knowledgeSources.id, sourceId));
      await recordAudit(tx, {
        tenantId,
        actor: ingestActor,
        action: "knowledge_source.failed",
        target: { type: "knowledge_source", id: sourceId },
        requestId: null,
      });
      deps.logger.warn({ sourceId, error }, "knowledge source could not be ingested");
    };

    let page: PageText;
    if (source.kind === "url") {
      page = source.url ? await fetchPageText(deps, source.url) : { ok: false, error: "no_url" };
    } else {
      page = { ok: true, text: tidy(source.content ?? "") };
    }
    if (!page.ok) return fail(page.error);
    const chunks = chunkText(page.text);
    if (chunks.length === 0) return fail("no_text");

    // Checked after the fetch, so the budget row isn't locked while a slow site answers.
    const day = utcDay((deps.now ?? (() => new Date()))());
    const used = await lockUsage(tx, tenantId, day);
    if (totalTokens(used) >= deps.dailyTokenBudget) return fail("daily_budget_reached");

    let embedded: Awaited<ReturnType<typeof embedTexts>>;
    try {
      embedded = await embedTexts(deps.embeddingModel, chunks);
    } catch (error) {
      // A wrong key or a provider outage. Retrying the job would end the same way, and a dead
      // job would leave the source `pending` with no sign of what went wrong.
      deps.logger.warn({ err: errorSummary(error), sourceId }, "embedding failed");
      return fail("embedding_failed");
    }
    const { embeddings, tokens } = embedded;
    const modelId = embeddingModelId(deps.embeddingModel);
    await recordUsage(tx, tenantId, day, { inputTokens: tokens, outputTokens: 0 });
    if (embeddings.length !== chunks.length) {
      throw new Error(`ingest: ${embeddings.length} embeddings for ${chunks.length} chunks`);
    }

    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
    await tx.insert(knowledgeChunks).values(
      chunks.map((content, position) => ({
        tenantId,
        sourceId,
        position,
        content,
        embedding: embeddings[position] ?? [],
        embeddingModel: modelId,
      })),
    );
    await tx
      .update(knowledgeSources)
      .set({
        status: "ready",
        error: null,
        chunkCount: chunks.length,
        ingestedAt: new Date(),
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
  };
}
