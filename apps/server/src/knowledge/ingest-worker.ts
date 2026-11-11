import {
  type EmbeddingModel,
  EmbedError,
  embeddingModelId,
  embedTexts,
  isTemporaryAiFailure,
  tokenBound,
} from "@helpos/ai";
import { enqueue, eq, schema, type TenantTransaction, type TenantTx } from "@helpos/db";
import { SafeFetchError, type safeFetch } from "@helpos/safe-fetch";
import { Parser } from "htmlparser2";
import type { Logger } from "pino";
import { AiBusyError, aiBudget, nextUtcDay } from "../ai-budget/budget.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Clock, ServerConfig } from "../services.ts";
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
  clock: Clock;
  /**
   * Embedding tokens count toward the same daily budget as drafting. `fetchRetryDelaysMs`:
   * waits before each new try of a page that failed on a temporary error.
   */
  config: Pick<ServerConfig, "dailyTokenBudget" | "fetchRetryDelaysMs">;
  /** Aborts the embedding calls in flight when the server shuts down. */
  shutdown?: AbortSignal | undefined;
}

const ingestActor = { type: "system", id: "ingest-source" } as const;

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
const isTemporary = (error: string) => temporaryErrors.has(error);

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
  // Withheld for legal reasons. Not 401 or 403: a bot block answers those too, so the last
  // good passages stay, and the source shows `failed` for someone to look at.
  "http_451",
]);

/**
 * How long a source waits after a temporary problem (the site or the embedding provider down)
 * before its one more try.
 */
export const retryDelayMs = 15 * 60_000;

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

/**
 * Fetches a page, trying again soon after a quick temporary error. Not after a timeout: that
 * try already took the whole timeout, and ingest jobs run one at a time, so it waits for its
 * later try instead of holding up every other source. No transaction is open meanwhile.
 */
async function fetchWithRetries(deps: IngestWorkerDeps, url: string): Promise<PageText> {
  let page = await fetchPageText(deps, url);
  for (const delay of deps.config.fetchRetryDelaysMs) {
    if (page.ok || !isTemporary(page.error) || page.error === "timeout") return page;
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
      return decodeUndeclared(bytes);
    }
  }
  return decodeUndeclared(bytes);
}

function decodeUndeclared(bytes: Uint8Array): string {
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

/**
 * Runs once every attempt failed. The handler throws only on database errors (everything
 * else marks the source itself), so this is a database that stayed broken: the source is
 * marked `failed` with `ingest_error`, for someone to re-ingest, instead of staying `pending`
 * with no job left to run it. The last good passages stay in use.
 *
 * Only if no newer ingest request came in since the job was queued (`requests`): an edit or a
 * re-ingest asked for after that has its own run waiting, and failing the source here would
 * make that run quit ("not pending") and the change never get ingested. That request's run may
 * be this very job (a pending source reuses its queued one), so a fresh job is queued for it.
 */
export async function handleIngestGaveUp(
  payload: { tenantId: string; sourceId: string; requests: number },
  tx: TenantTx,
): Promise<void> {
  const { tenantId, sourceId, requests } = payload;
  const [source] = await tx
    .select({ status: knowledgeSources.status, requests: knowledgeSources.ingestRequests })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .for("update");
  if (source?.status !== "pending") return;
  if (source.requests !== requests) {
    await enqueue(tx, ingestSourceJob, { tenantId, sourceId, requests: source.requests });
    return;
  }
  await tx
    .update(knowledgeSources)
    .set({ status: "failed", error: "ingest_error" })
    .where(eq(knowledgeSources.id, sourceId));
  await recordAudit(tx, {
    tenantId,
    actor: ingestActor,
    action: "knowledge_source.failed",
    target: { type: "knowledge_source", id: sourceId },
    requestId: null,
  });
}

/**
 * Turns one knowledge source into embedded chunks. A page that fails on a temporary error is
 * tried again a few seconds later. If the site or the embedding provider is still down, the
 * source waits, `pending` with the reason, for one more try 15 minutes later. A spent daily
 * budget is a wait too, until it resets. A source that can't be used (blocked URL, 404, no
 * text, wrong embedding key, still down after its wait) is marked `failed` with a short
 * reason, so a source never stays `pending` with no job to run it. Only database errors
 * throw, and pg-boss retries those. When a re-ingest fails, the chunks from the last
 * good ingest stay in use, so a flaky site doesn't empty the knowledge base, unless the page's
 * answer shows they no longer describe it (`supersededBy`).
 *
 * The fetch and the embedding call run with no transaction open, so a slow site holds no
 * connection or row lock: a delete or re-ingest of the source never waits for it.
 */
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
      await enqueue(tx, ingestSourceJob, { tenantId, sourceId, requests: current.requests });
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

    const started = now();

    /** Not a failure: the source stays `pending` with the reason, and runs again by itself. */
    const waitUntil = (reason: string, startAfter: Date, singletonKey: string) =>
      transaction(async (tx) => {
        if (!(await lockIfCurrent(tx))) return;
        await tx
          .update(knowledgeSources)
          .set({ error: reason })
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
    const waitedOnce =
      source.error !== null &&
      (source.error === "embedding_unavailable" || isTemporary(source.error));
    const retryLater = (reason: string) => {
      const retryAt = new Date(started.getTime() + retryDelayMs);
      return waitUntil(reason, retryAt, `${sourceId}:retry:${retryAt.toISOString()}`);
    };

    // The budget resets at midnight UTC. One waiting job per source per day, however often
    // it's asked for meanwhile. A source that already had its one more try keeps that reason,
    // so the budget wait doesn't give it another.
    const waitForBudget = (resetsAt: Date) => {
      const reason = waitedOnce && source.error ? source.error : "daily_budget_reached";
      return waitUntil(reason, resetsAt, `${sourceId}:after:${resetsAt.toISOString()}`);
    };
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
          : { ok: false, error: "no_url" };
      } else {
        page = { ok: true, text: tidyAuthored(source.content ?? "") };
      }
      if (!page.ok) {
        if (isTemporary(page.error) && !waitedOnce) return retryLater(page.error);
        return fail(page.error);
      }
      // Stops early on a huge page: past the limit, it fails anyway.
      chunks = chunkText(page.text, maxChunks);
    } catch (error) {
      // Reading the page broke (a bug, or a page no parser expects). A retry would break the
      // same way, and then the source would stay `pending` with no job: it fails instead.
      deps.logger.warn({ err: error, sourceId }, "reading the page failed");
      return fail("ingest_error");
    }
    if (chunks.length === 0) return fail("no_text");
    if (chunks.length > maxChunks) return fail("too_long");

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
      if (!isTemporaryAiFailure(error)) return fail("embedding_failed");
      return waitedOnce ? fail("embedding_unavailable") : retryLater("embedding_unavailable");
    }
    const { embeddings } = embedded;
    const modelId = embeddingModelId(deps.embeddingModel);
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
