import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "./client.ts";
import {
  type KnowledgeVisibility,
  knowledgeEmbeddingDimensions,
  knowledgeVisibilities,
} from "./schema.ts";

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
  /** Only sources with one of these visibilities. Omitted: all of them. */
  visibility?: KnowledgeVisibility[] | undefined;
}

const querySchema = z.strictObject({
  tenantId: z.uuid(),
  embedding: z.array(z.number().finite()).length(knowledgeEmbeddingDimensions),
  embeddingModel: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(20),
  visibility: z.array(z.enum(knowledgeVisibilities)).min(1).optional(),
});

/**
 * The only vector search over knowledge (ADR 0009 §4). Run it inside withTenant(): RLS limits
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
  const { tenantId, embedding, embeddingModel, limit, visibility } = querySchema.parse(query);
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
        ${visibilityFilter(tenantId, visibility)}
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
function visibilityFilter(tenantId: string, visibility: KnowledgeVisibility[] | undefined) {
  if (!visibility) return sql``;
  return sql`and source_id in (
    select id from knowledge_sources
    where tenant_id = ${tenantId} and visibility in (${sql.join(
      visibility.map((v) => sql`${v}`),
      sql`, `,
    )})
  )`;
}
