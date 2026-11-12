import {
  and,
  enqueue,
  eq,
  isKnowledgeUrlTaken,
  isUniqueViolation,
  normalizeKnowledgeUrl,
  schema,
  sql,
  type TenantTx,
  uuidv7,
} from "@helpos/db";
import { type AuditAction, type Auditor, nothingToAudit } from "../audit/audit.ts";
import { ingestSourceJob } from "./jobs.ts";

const { knowledgeChunks, knowledgeSources } = schema;
type SourceRow = typeof knowledgeSources.$inferSelect;
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

export function queueIngest(
  tx: TenantTx,
  input: { tenantId: string; sourceId: string; requests: number },
  queue: IngestQueue,
): Promise<string> {
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
  const [row] = await tx
    .update(knowledgeSources)
    .set({
      state:
        found.state.status === "waiting" && found.state.reason.code === "daily_budget_reached"
          ? found.state
          : { status: "pending" },
      retryCount: 0,
      ingestRequests: sql`${knowledgeSources.ingestRequests} + 1`,
    })
    .where(eq(knowledgeSources.id, id))
    .returning();
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
    found.state.status === "pending" || found.state.status === "waiting"
      ? { kind: "reuse" }
      : { kind: "fresh" },
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

  const [row] = await tx
    .update(knowledgeSources)
    .set({
      ...(title ? { title: input.title } : {}),
      ...(visibility ? { visibility: input.visibility } : {}),
      ...(content
        ? {
            content: input.content,
            state: { status: "pending" as const },
            retryCount: 0,
            chunkCount: 0,
            embeddingModel: null,
            ingestRequests: sql`${knowledgeSources.ingestRequests} + 1`,
          }
        : {}),
    })
    .where(eq(knowledgeSources.id, id))
    .returning();
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
