import { type EmbeddingModel, embeddingModelId, embedTexts } from "@helpos/ai";
import { eq, schema, type TenantTx } from "@helpos/db";
import { SafeFetchError, type safeFetch } from "@helpos/safe-fetch";
import type { Logger } from "pino";
import { recordUsage, totalTokens, usageOn, utcDay } from "../ai-budget/budget.ts";
import { errorSummary } from "../app.ts";
import { recordAudit } from "../audit/audit.ts";
import { chunkText, maxChunks } from "./chunk.ts";
import { extractHtml, tidyAuthored } from "./extract.ts";

const { knowledgeChunks, knowledgeSources } = schema;

/** The SSRF-safe fetch. A parameter only so tests can reach a local test server. */
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

/**
 * The charset a page declares in `<meta charset>` or `<meta http-equiv content>`, looked for
 * in its first 1024 bytes as browsers do. Bounded, so a huge page costs nothing extra.
 */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const label = /<meta[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1];
  // A page readable as ASCII so far can't really be UTF-16; browsers read it as UTF-8.
  return label && /^utf-16/i.test(label) ? "utf-8" : label;
}

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

  // `charset="iso-8859-1"` is valid too: the quotes aren't part of the label. Without one in
  // the header, a page can still say it in a <meta> tag.
  const declared =
    params
      .find((p) => p.startsWith("charset="))
      ?.slice(8)
      .replaceAll(/^["']|["']$/g, "")
      .trim() || (isHtml ? metaCharset(res.body) : undefined);
  const body = decode(res.body, declared);
  return { ok: true, text: isHtml ? extractHtml(body).text : tidyAuthored(body) };
}

/**
 * Bytes to text in the declared charset. Undeclared (or unknown): UTF-8 when the bytes are
 * valid UTF-8, as nearly all pages are, else windows-1252, the old web's default.
 */
function decode(bytes: Uint8Array, charset: string | undefined): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // An unknown label: guess as if none was given.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * Turns one knowledge source into embedded chunks. A source that can't be used (blocked URL,
 * 404, no text, budget spent, embedding call failed) is marked `failed` with a short reason,
 * and the job ends without a retry, so a source never stays `pending` after its job is done.
 * Only database errors throw, and pg-boss retries those. When a re-ingest fails, the chunks
 * from the last good ingest stay in use, so a flaky site doesn't empty the knowledge base,
 * unless the page answers 404 or 410: then it is gone, and so are its passages.
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
      // The page says it's gone, so its old passages must stop being cited. Any other
      // failure (a 5xx, a timeout, the budget) may pass, so the last good passages stay.
      const gone = error === "http_404" || error === "http_410";
      if (gone) await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
      await tx
        .update(knowledgeSources)
        .set({ status: "failed", error, ...(gone ? { chunkCount: 0, embeddingModel: null } : {}) })
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
      page = { ok: true, text: tidyAuthored(source.content ?? "") };
    }
    if (!page.ok) return fail(page.error);
    const chunks = chunkText(page.text);
    if (chunks.length === 0) return fail("no_text");
    if (chunks.length > maxChunks) return fail("too_long");

    // Read, not locked: holding the budget row through the embedding call would stop every
    // draft in the workspace until this ingest commits. Concurrent ingests can each pass the
    // check and overshoot by one embedding call, like a draft that starts just under the cap.
    const day = utcDay((deps.now ?? (() => new Date()))());
    const used = await usageOn(tx, day);
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
      // A broken server. Retrying would pay again for the same answer; the spend is recorded.
      deps.logger.warn(
        { sourceId, embeddings: embeddings.length, chunks: chunks.length },
        "embedding server returned the wrong number of vectors",
      );
      return fail("embedding_failed");
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
