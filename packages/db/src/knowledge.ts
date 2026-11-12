import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "./client.ts";
import { isUniqueViolation } from "./errors.ts";
import { type KnowledgeVisibility, knowledgeEmbeddingDimensions } from "./schema.ts";

/**
 * The form a `url` source's URL is stored in, so one page is one source. WHATWG parsing already
 * lowercases the host and drops a default port. The fragment is dropped here: it names a spot
 * on the same page, which the fetch never sends. Path and query stay as they are, since a
 * server may treat their case as meaningful.
 */
export function normalizeKnowledgeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

/** True when an insert failed because the workspace already has a source for this URL. */
export function isKnowledgeUrlTaken(error: unknown): boolean {
  return isUniqueViolation(error, "knowledge_sources_tenant_url");
}

/** One retrieved passage, with the source it came from. */
export interface KnowledgeHit {
  chunkId: string;
  sourceId: string;
  title: string;
  url: string | null;
  content: string;
  visibility: KnowledgeVisibility;
  /** Cosine distance: 0 is identical, 2 is opposite. */
  distance: number;
}

export interface KnowledgeQuery {
  tenantId: string;
  embedding: number[];
  /** The model that embedded the query. Chunks from any other model are never compared. */
  embeddingModel: string;
  limit: number;
  audience: "approver" | "customer";
}

const scopeSchema = z.strictObject({
  tenantId: z.uuid(),
  embeddingModel: z.string().min(1).max(200),
  audience: z.enum(["approver", "customer"]),
});

const querySchema = scopeSchema.extend({
  embedding: z.array(z.number().finite()).length(knowledgeEmbeddingDimensions),
  limit: z.number().int().min(1).max(20),
});

export async function hasSearchableKnowledge(
  tx: TenantTx,
  query: Pick<KnowledgeQuery, "tenantId" | "embeddingModel" | "audience">,
): Promise<boolean> {
  const { tenantId, embeddingModel, audience } = scopeSchema.parse(query);
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from knowledge_chunks
      where tenant_id = ${tenantId} and embedding_model = ${embeddingModel}
        ${audienceFilter(tenantId, audience)}
    ) as found`);
  return row?.found ?? false;
}

/**
 * The only vector search over knowledge. Run it inside withTenant(): RLS limits
 * rows to the current tenant, and the explicit `tenant_id` filter says so in the query too.
 *
 * The HNSW index is shared by all tenants and applies filters only after it searches, so a
 * small tenant among large ones could get nothing back. Iterative scan makes the index keep
 * going until enough rows pass the filter. It's set transaction-locally (`SET LOCAL`), so a
 * pooled connection never carries it into another request.
 */
export async function searchKnowledge(
  tx: TenantTx,
  query: KnowledgeQuery,
): Promise<KnowledgeHit[]> {
  const { tenantId, embedding, embeddingModel, limit, audience } = querySchema.parse(query);
  await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
  const vector = JSON.stringify(embedding);
  // relaxed_order may return rows slightly out of order, so the outer query sorts again
  // (the pattern pgvector documents for iterative scans).
  const rows = await tx.execute<{
    chunkId: string;
    sourceId: string;
    title: string;
    url: string | null;
    content: string;
    visibility: KnowledgeVisibility;
    distance: number;
  }>(sql`
    with nearest as materialized (
      select id, source_id, content, embedding <=> ${vector}::vector as distance
      from knowledge_chunks
      where tenant_id = ${tenantId} and embedding_model = ${embeddingModel}
        ${audienceFilter(tenantId, audience)}
      order by embedding <=> ${vector}::vector
      limit ${limit}
    )
    select n.id as "chunkId", n.source_id as "sourceId", s.title, s.url, n.content,
      s.visibility, n.distance
    from nearest n
    join knowledge_sources s on s.tenant_id = ${tenantId} and s.id = n.source_id
    order by n.distance, n.id`);
  return rows.map((r) => ({ ...r, distance: Number(r.distance) }));
}

/**
 * Inside the nearest-neighbour scan, not after it, so iterative scan keeps going until enough
 * passages of the wanted visibility are found.
 */
function audienceFilter(tenantId: string, audience: KnowledgeQuery["audience"]) {
  if (audience === "approver") return sql``;
  return sql`and source_id in (
    select id from knowledge_sources
    where tenant_id = ${tenantId} and visibility = 'public'
  )`;
}
