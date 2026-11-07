import {
  type EmbeddingModel,
  EmbedError,
  embeddingModelId,
  embedTexts,
  isTemporaryAiFailure,
} from "@helpos/ai";
import { enqueue, eq, schema, type TenantTransaction, type TenantTx } from "@helpos/db";
import { SafeFetchError, type safeFetch } from "@helpos/safe-fetch";
import { Parser } from "htmlparser2";
import type { Logger } from "pino";
import { recordUsage, totalTokens, usageOn, utcDay } from "../ai-budget/budget.ts";
import { errorSummary } from "../app.ts";
import { recordAudit } from "../audit/audit.ts";
import { chunkText, maxChunks } from "./chunk.ts";
import { extractHtml, tidyAuthored } from "./extract.ts";
import { ingestSourceJob } from "./jobs.ts";

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
  /** Waits before each new try of a page that failed on a temporary error. Shorter in tests. */
  fetchRetryDelaysMs?: readonly number[] | undefined;
}

export const ingestActor = { type: "system", id: "ingest-source" } as const;

/** A help-center page is far smaller; anything bigger is not an article. */
export const maxPageBytes = 2 * 1024 * 1024;
const fetchTimeoutMs = 15_000;

type PageText = { ok: true; text: string } | { ok: false; error: string };

/**
 * A site mid-deploy or briefly overloaded: worth another try in a few seconds. Not 501 or 505
 * (the server can't ever answer this), and not a name that doesn't resolve (usually a typo).
 */
const temporaryErrors = new Set([
  "timeout",
  "network",
  "http_408",
  "http_425",
  "http_429",
  "http_500",
  "http_502",
  "http_503",
  "http_504",
]);
export const isTemporary = (error: string) => temporaryErrors.has(error);
const defaultFetchRetryDelaysMs = [1_000, 5_000];

/**
 * The page's answer says the old passages no longer describe it: it's gone, or it now has no
 * text, too much (too many passages, or too many bytes), or isn't a page. They're removed, so drafts stop citing them. Other failures
 * (a 5xx, a timeout, a blocked address) may pass, so the last good passages stay.
 */
const supersededBy = new Set([
  "http_404",
  "http_410",
  "no_text",
  "too_long",
  "too_large",
  "unsupported_content_type",
  // Now behind a login, or withheld: the owner took it out of public view.
  "http_401",
  "http_403",
  "http_451",
]);

/** How long a source waits after the embedding provider was down or rate-limited. */
export const embedRetryDelayMs = 15 * 60_000;

const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/x-markdown"]);

/**
 * The charset a page declares in `<meta charset>` or `<meta http-equiv content>`, looked for
 * in its first 1024 bytes as browsers do. Bounded, so a huge page costs nothing extra.
 */
function metaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  let label: string | undefined;
  // Parsed, not searched: "charset=" in another tag's text (a description) declares nothing.
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (label || name !== "meta") return;
        if (attribs.charset) label = attribs.charset.trim();
        else if (attribs["http-equiv"]?.trim().toLowerCase() === "content-type") {
          label = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(attribs.content ?? "")?.[1];
        }
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true },
  );
  parser.write(head);
  parser.end();
  // A page readable as ASCII so far can't really be UTF-16; browsers read it as UTF-8.
  return label && /^utf-16/i.test(label) ? "utf-8" : label || undefined;
}

/** Fetches a page, trying again after a temporary error. No transaction is open meanwhile. */
async function fetchWithRetries(deps: IngestWorkerDeps, url: string): Promise<PageText> {
  let page = await fetchPageText(deps, url);
  for (const delay of deps.fetchRetryDelaysMs ?? defaultFetchRetryDelaysMs) {
    if (page.ok || !isTemporary(page.error)) return page;
    await new Promise((done) => setTimeout(done, delay));
    page = await fetchPageText(deps, url);
  }
  return page;
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
function decode(bytes: Uint8Array, declared: string | undefined): string {
  // A byte order mark settles it, whatever the page or the server says.
  const bom =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? "utf-16le"
          : undefined;
  // UTF-16 text has a zero byte in nearly every Latin character. A "utf-16" label on bytes
  // without one is a misconfigured server, and reading it as UTF-16 would make it nonsense.
  const misread =
    !bom && declared && /^utf-16/i.test(declared) && !bytes.subarray(0, 1024).includes(0);
  const charset = bom ?? (misread ? undefined : declared);
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

/** The vector for one chunk. The count was checked, so a missing one is a bug: say so. */
function vectorAt(embeddings: number[][], position: number): number[] {
  const vector = embeddings[position];
  if (!vector) throw new Error(`ingest: no vector for chunk ${position}`);
  return vector;
}

/** The start of the next UTC day, when the daily budget resets. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Turns one knowledge source into embedded chunks. A page that fails on a temporary error is
 * tried again a few seconds later. A source that can't be used (blocked URL, 404, no text,
 * embedding call failed) is marked `failed` with a short reason, and the job ends without a
 * retry, so a source never stays `pending` after its job is done. A spent daily budget is only
 * a wait: the source stays `pending` and runs again when the budget resets. Only database
 * errors throw, and pg-boss retries those. When a re-ingest fails, the chunks from the last
 * good ingest stay in use, so a flaky site doesn't empty the knowledge base, unless the page's
 * answer shows they no longer describe it (`supersededBy`).
 *
 * The fetch and the embedding call run with no transaction open, so a slow site holds no
 * connection or row lock: a delete or re-ingest of the source never waits for it.
 */
export function handleIngestSource(deps: IngestWorkerDeps) {
  return async (
    payload: { tenantId: string; sourceId: string },
    transaction: TenantTransaction,
  ): Promise<void> => {
    const { tenantId, sourceId } = payload;
    const now = deps.now ?? (() => new Date());
    const [source] = await transaction((tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId)),
    );
    if (!source) return; // deleted before the job ran
    if (source.status !== "pending") return; // a retry after the work was done
    // Every request to ingest it again counts up. If one comes in while this run is fetching,
    // the result is from before it: see `lockIfCurrent`.
    const requests = source.ingestRequests;

    /**
     * Locks the source and checks this run's result is still wanted. Deleted: nothing to
     * write. Asked to ingest again meanwhile: that request gets a run of its own, because its
     * job may be this one (a pending source reuses its queued job).
     */
    const lockIfCurrent = async (tx: TenantTx): Promise<boolean> => {
      const [current] = await tx
        .select({ status: knowledgeSources.status, requests: knowledgeSources.ingestRequests })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, sourceId))
        .for("update");
      if (current?.status !== "pending") return false;
      if (current.requests === requests) return true;
      await enqueue(tx, ingestSourceJob, { tenantId, sourceId });
      return false;
    };

    const fail = (error: string) =>
      transaction(async (tx) => {
        if (!(await lockIfCurrent(tx))) return;
        const gone = supersededBy.has(error);
        if (gone) await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
        await tx
          .update(knowledgeSources)
          .set({
            status: "failed",
            error,
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
        deps.logger.warn({ sourceId, error }, "knowledge source could not be ingested");
      });

    // Before the fetch, so a source that must wait doesn't fetch its page twice. Read, not
    // locked: holding the budget row through the embedding call would stop every draft in the
    // workspace until this ingest commits. Concurrent ingests can each pass the check and
    // overshoot by one embedding call, like a draft that starts just under the cap.
    const started = now();
    const day = utcDay(started);

    /** Not a failure: the source stays `pending` with the reason, and runs again by itself. */
    const waitUntil = (reason: string, startAfter: Date, singletonKey: string) =>
      transaction(async (tx) => {
        if (!(await lockIfCurrent(tx))) return;
        await tx
          .update(knowledgeSources)
          .set({ error: reason })
          .where(eq(knowledgeSources.id, sourceId));
        await enqueue(tx, ingestSourceJob, { tenantId, sourceId }, { singletonKey, startAfter });
        deps.logger.warn({ sourceId, reason, startAfter }, "knowledge source waits to run again");
      });

    const used = await transaction((tx) => usageOn(tx, day));
    if (totalTokens(used) >= deps.dailyTokenBudget) {
      // The budget resets at midnight UTC. One waiting job per source per day, however often
      // it's asked for meanwhile.
      const resetsAt = nextUtcDay(started);
      return waitUntil("daily_budget_reached", resetsAt, `${sourceId}:after:${utcDay(resetsAt)}`);
    }

    let page: PageText;
    if (source.kind === "url") {
      page = source.url ? await fetchWithRetries(deps, source.url) : { ok: false, error: "no_url" };
    } else {
      page = { ok: true, text: tidyAuthored(source.content ?? "") };
    }
    if (!page.ok) return fail(page.error);
    // Stops early on a huge page: past the limit, it fails anyway.
    const chunks = chunkText(page.text, maxChunks);
    if (chunks.length === 0) return fail("no_text");
    if (chunks.length > maxChunks) return fail("too_long");

    let embedded: Awaited<ReturnType<typeof embedTexts>>;
    try {
      embedded = await embedTexts(deps.embeddingModel, chunks);
    } catch (error) {
      // After the SDK's own retries. Batches embedded before the failure were paid for, so
      // they count.
      deps.logger.warn({ err: errorSummary(error), sourceId }, "embedding failed");
      const spent = error instanceof EmbedError ? error.tokens : 0;
      if (spent > 0) {
        await transaction((tx) =>
          recordUsage(tx, tenantId, day, { inputTokens: spent, outputTokens: 0 }),
        );
      }
      // The provider is down or rate-limited: try again later. A wrong key or a broken model
      // would end the same way every time, so that fails, rather than leave it `pending`.
      if (isTemporaryAiFailure(error)) {
        const retryAt = new Date(started.getTime() + embedRetryDelayMs);
        return waitUntil(
          "embedding_unavailable",
          retryAt,
          `${sourceId}:retry:${retryAt.toISOString()}`,
        );
      }
      return fail("embedding_failed");
    }
    const { embeddings, tokens } = embedded;
    const modelId = embeddingModelId(deps.embeddingModel);
    // Paid for whatever happens next, so it's committed on its own.
    await transaction((tx) =>
      recordUsage(tx, tenantId, day, { inputTokens: tokens, outputTokens: 0 }),
    );
    if (embeddings.length !== chunks.length) {
      // A broken server. Retrying would pay again for the same answer.
      deps.logger.warn(
        { sourceId, embeddings: embeddings.length, chunks: chunks.length },
        "embedding server returned the wrong number of vectors",
      );
      return fail("embedding_failed");
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
    });
  };
}
