import {
  and,
  enqueue,
  eq,
  inArray,
  isKnowledgeUrlTaken,
  isUniqueViolation,
  normalizeKnowledgeUrl,
  type SQL,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import { builtInActors } from "@helpos/db/actor";
import { type AuditAction, type Auditor, nothingToAudit, recordAudit } from "../audit/audit.ts";
import { ingestSourceJob } from "./jobs.ts";

const { knowledgeChunks, knowledgeSources } = schema;
type SourceRow = typeof knowledgeSources.$inferSelect;
type SourceValues = typeof knowledgeSources.$inferInsert;
type SourceState = schema.KnowledgeSourceState;
type SourceStatus = SourceState["status"];
type StateOf<S extends SourceStatus> = Extract<SourceState, { status: S }>;

interface Transition {
  readonly from: readonly SourceStatus[];
  readonly to: SourceStatus;
}

const everyStatus = {
  pending: true,
  ready: true,
  failed: true,
  waiting: true,
} as const satisfies Record<SourceStatus, true>;
export const sourceStatuses = Object.keys(everyStatus) as (keyof typeof everyStatus)[];
const ingesting = ["pending", "waiting"] as const satisfies SourceStatus[];

export const sourceTransitions = {
  reingest: { from: sourceStatuses, to: "pending" },
  reingestWhileOverBudget: { from: ["waiting"], to: "waiting" },
  editContent: { from: sourceStatuses, to: "pending" },
  wait: { from: ingesting, to: "waiting" },
  fail: { from: ingesting, to: "failed" },
  ingested: { from: ingesting, to: "ready" },
} as const satisfies Record<string, Transition>;

type SourceOperation = keyof typeof sourceTransitions;
type SourceSet = {
  [K in Exclude<keyof SourceValues, "state">]?: SourceValues[K] | SQL | undefined;
};

function isIngesting(state: SourceState): boolean {
  return (ingesting as readonly SourceStatus[]).includes(state.status);
}

async function change<O extends SourceOperation>(
  tx: TenantTx,
  operation: O,
  id: string,
  state: StateOf<(typeof sourceTransitions)[O]["to"]>,
  set: SourceSet = {},
): Promise<SourceRow | undefined> {
  const { from } = sourceTransitions[operation];
  const [row] = await tx
    .update(knowledgeSources)
    .set({ ...set, state })
    .where(
      and(
        eq(knowledgeSources.id, id),
        inArray(sql`(${knowledgeSources.state}->>'status')`, [...from]),
      ),
    )
    .returning();
  return row;
}

type CreateSourceInput = Pick<SourceRow, "tenantId" | "title"> & {
  slug?: string | undefined;
  visibility?: SourceRow["visibility"] | undefined;
} & ({ kind: "url"; url: string } | { kind: "markdown"; content: string });
type UpdateSourceInput = Pick<SourceRow, "id" | "tenantId"> & {
  title?: string | undefined;
  visibility?: SourceRow["visibility"] | undefined;
  content?: string | undefined;
};
type CreateSourceResult =
  | { kind: "created"; source: SourceRow }
  | { kind: "slug_taken" }
  | { kind: "url_taken"; sourceId?: string };

type IngestQueue =
  | { kind: "reuse" }
  | { kind: "fresh" }
  | { kind: "retry" | "budget"; startAfter: Date };

type IngestWrite = "written" | "stale";

export interface IngestJob {
  tenantId: string;
  sourceId: string;
  requests: number;
}

export function queueIngest(tx: TenantTx, input: IngestJob, queue: IngestQueue): Promise<string> {
  const options =
    queue.kind === "reuse"
      ? { singletonKey: input.sourceId }
      : queue.kind === "fresh"
        ? {}
        : {
            singletonKey: `${input.sourceId}:${queue.kind === "retry" ? "retry" : "after"}:${queue.startAfter.toISOString()}`,
            startAfter: queue.startAfter,
          };
  return enqueue(tx, ingestSourceJob, input, options);
}

export function slugify(title: string): string {
  return (
    title
      .normalize("NFKD")
      // NFKD splits "é" into "e" plus an accent mark; dropping the marks keeps the word whole.
      .replaceAll(/\p{M}/gu, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "")
  );
}

export async function createSource(
  tx: TenantTx,
  audit: Auditor,
  input: CreateSourceInput,
): Promise<CreateSourceResult> {
  const { tenantId } = input;
  const id = uuidv7();
  const url = input.kind === "url" ? normalizeKnowledgeUrl(input.url) : null;
  const base = slugify(input.title);
  const suffix = () => uuidv7().slice(-12);
  const slugs = input.slug
    ? [input.slug]
    : [
        ...(base ? [base] : []),
        ...Array.from({ length: 3 }, () => `${base || "source"}-${suffix()}`),
      ];

  try {
    for (const slug of slugs) {
      const created = await insertSource(slug);
      if (created) return { kind: "created", source: created };
    }
  } catch (error) {
    if (!url || !isKnowledgeUrlTaken(error)) throw error;
    const sourceId = await sourceWithUrl(url);
    // Deleted between the failed insert and this read: rare, and a retry would succeed.
    return { kind: "url_taken", ...(sourceId ? { sourceId } : {}) };
  }
  // Postgres may report the slug before the URL, so a repeat with the same slug lands here.
  const sourceId = url ? await sourceWithUrl(url) : undefined;
  if (sourceId) return { kind: "url_taken", sourceId };
  return { kind: "slug_taken" };

  async function sourceWithUrl(url: string): Promise<string | undefined> {
    const [existing] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.kind, "url"), eq(knowledgeSources.url, url)));
    return existing?.id;
  }

  async function insertSource(slug: string): Promise<SourceRow | undefined> {
    try {
      return await tx.transaction(async (tx) => {
        const [row] = await tx
          .insert(knowledgeSources)
          .values({
            id,
            tenantId,
            slug,
            kind: input.kind,
            title: input.title,
            url,
            content: input.kind === "markdown" ? input.content : null,
            ...(input.visibility ? { visibility: input.visibility } : {}),
          })
          .returning();
        if (!row) throw new Error("create knowledge source: insert returned no row");
        await audit(tx, "knowledge_source.created", { type: "knowledge_source", id });
        await queueIngest(
          tx,
          { tenantId, sourceId: id, requests: row.ingestRequests },
          { kind: "reuse" },
        );
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, "knowledge_sources_tenant_slug")) return undefined;
      throw error;
    }
  }
}

export async function requestIngest(
  tx: TenantTx,
  audit: Auditor,
  input: { id: string; tenantId: string },
): Promise<SourceRow | "not_found" | "managed_in_git"> {
  const { id, tenantId } = input;
  const [found] = await tx
    .select({
      managedBy: knowledgeSources.managedBy,
      state: knowledgeSources.state,
    })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .for("update");
  if (!found) return "not_found" as const;
  if (found.managedBy === "git") return "managed_in_git" as const;
  const { state } = found;
  const set = { retryCount: 0, ingestRequests: sql`${knowledgeSources.ingestRequests} + 1` };
  const row =
    state.status === "waiting" && state.reason.code === "daily_budget_reached"
      ? await change(tx, "reingestWhileOverBudget", id, state, set)
      : await change(tx, "reingest", id, { status: "pending" }, set);
  if (!row) throw new Error("reingest: update returned no row");
  await audit(tx, "knowledge_source.reingest_requested", { type: "knowledge_source", id });
  // Already pending: reuse its job rather than queue two. If that job is already fetching,
  // it sees this request when it writes (the count went up) and queues a run for it.
  // Otherwise always queue a new one. The last job may have committed but still look
  // unfinished to pg-boss, and reusing it would leave this source pending with no job. An
  // extra job is harmless: the worker skips ready and failed sources.
  await queueIngest(
    tx,
    { tenantId, sourceId: id, requests: row.ingestRequests },
    isIngesting(state) ? { kind: "reuse" } : { kind: "fresh" },
  );
  return row;
}

export async function updateSource(
  tx: TenantTx,
  audit: Auditor,
  input: UpdateSourceInput,
): Promise<SourceRow | "not_found" | "managed_in_git" | "content_not_editable"> {
  const { id, tenantId } = input;
  const [found] = await tx
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .for("update");
  if (!found) return "not_found" as const;
  if (found.managedBy === "git") return "managed_in_git" as const;
  if (input.content !== undefined && found.kind !== "markdown") {
    return "content_not_editable" as const;
  }
  const title = input.title !== undefined && input.title !== found.title;
  const visibility = input.visibility !== undefined && input.visibility !== found.visibility;
  const content = input.content !== undefined && input.content !== found.content;
  if (!title && !visibility && !content) {
    nothingToAudit("same title, visibility and content");
    return found;
  }

  const set = {
    ...(title ? { title: input.title } : {}),
    ...(visibility ? { visibility: input.visibility } : {}),
  };
  const row = content
    ? await change(
        tx,
        "editContent",
        id,
        { status: "pending" },
        {
          ...set,
          content: input.content,
          retryCount: 0,
          chunkCount: 0,
          embeddingModel: null,
          ingestRequests: sql`${knowledgeSources.ingestRequests} + 1`,
        },
      )
    : (
        await tx.update(knowledgeSources).set(set).where(eq(knowledgeSources.id, id)).returning()
      )[0];
  if (!row) throw new Error("update knowledge source: update returned no row");
  if (content) {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, id));
    await queueIngest(
      tx,
      {
        tenantId,
        sourceId: id,
        requests: row.ingestRequests,
      },
      { kind: "fresh" },
    );
  }
  const record = (action: AuditAction) => audit(tx, action, { type: "knowledge_source", id });
  if (title || content) await record("knowledge_source.edited");
  if (visibility) {
    await record(
      row.visibility === "public"
        ? "knowledge_source.made_public"
        : "knowledge_source.made_internal",
    );
  }
  return row;
}

export async function deleteSource(
  tx: TenantTx,
  audit: Auditor,
  input: { id: string },
): Promise<"deleted" | "not_found" | "managed_in_git"> {
  const { id } = input;
  const [found] = await tx
    .select({ managedBy: knowledgeSources.managedBy })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .for("update");
  if (!found) return "not_found" as const;
  if (found.managedBy === "git") return "managed_in_git" as const;
  await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
  await audit(tx, "knowledge_source.deleted", { type: "knowledge_source", id });
  return "deleted" as const;
}

export function seedSources(
  tx: TenantTx,
  rows: SourceValues[],
): Promise<{ id: string; requests: number }[]> {
  return tx
    .insert(knowledgeSources)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: knowledgeSources.id, requests: knowledgeSources.ingestRequests });
}

export async function lockIfCurrent(tx: TenantTx, job: IngestJob): Promise<boolean> {
  const { tenantId, sourceId, requests } = job;
  const [current] = await tx
    .select({ state: knowledgeSources.state, requests: knowledgeSources.ingestRequests })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, sourceId))
    .for("update");
  if (!current || !isIngesting(current.state)) return false;
  if (current.requests === requests) return true;
  await queueIngest(tx, { tenantId, sourceId, requests: current.requests }, { kind: "fresh" });
  return false;
}

function supersedes(reason: schema.KnowledgeFailureReason): boolean {
  return reason.code === "http_error"
    ? [404, 410, 451].includes(reason.status)
    : ["no_text", "too_long", "too_large", "unsupported_content_type"].includes(reason.code);
}

function recordIngest(tx: TenantTx, job: IngestJob, action: AuditAction): Promise<void> {
  return recordAudit(tx, {
    tenantId: job.tenantId,
    actor: builtInActors.ingestWorker,
    action,
    target: { type: "knowledge_source", id: job.sourceId },
    requestId: null,
  });
}

export async function failIngest(
  tx: TenantTx,
  job: IngestJob,
  reason: schema.KnowledgeFailureReason,
): Promise<IngestWrite> {
  if (!(await lockIfCurrent(tx, job))) return "stale";
  const gone = supersedes(reason);
  if (gone) await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, job.sourceId));
  await change(
    tx,
    "fail",
    job.sourceId,
    { status: "failed", reason },
    gone ? { chunkCount: 0, embeddingModel: null } : {},
  );
  await recordIngest(tx, job, "knowledge_source.failed");
  return "written";
}

export async function waitToIngest(
  tx: TenantTx,
  job: IngestJob,
  wait: {
    reason: schema.KnowledgeWaitReason;
    startAfter: Date;
    kind: "retry" | "budget";
    retryCount: number;
  },
): Promise<IngestWrite> {
  if (!(await lockIfCurrent(tx, job))) return "stale";
  const { reason, startAfter, kind, retryCount } = wait;
  await change(
    tx,
    "wait",
    job.sourceId,
    { status: "waiting", reason, retryAt: startAfter.toISOString() },
    { retryCount },
  );
  await queueIngest(tx, job, { kind, startAfter });
  return "written";
}

export async function storeIngested(
  tx: TenantTx,
  job: IngestJob,
  result: { passages: { content: string; embedding: number[] }[]; model: string; at: Date },
): Promise<IngestWrite> {
  if (!(await lockIfCurrent(tx, job))) return "stale";
  const { tenantId, sourceId } = job;
  await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
  await tx.insert(knowledgeChunks).values(
    result.passages.map(({ content, embedding }, position) => ({
      tenantId,
      sourceId,
      position,
      content,
      embedding,
      embeddingModel: result.model,
    })),
  );
  await change(
    tx,
    "ingested",
    sourceId,
    { status: "ready" },
    {
      retryCount: 0,
      chunkCount: result.passages.length,
      ingestedAt: result.at,
      embeddingModel: result.model,
    },
  );
  await recordIngest(tx, job, "knowledge_source.ingested");
  return "written";
}
