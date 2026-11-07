import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "./client.ts";
import { knowledgeEmbeddingDimensions } from "./schema.ts";

/** One retrieved passage, with the source it came from. */
export interface KnowledgeHit {
  chunkId: string;
  sourceId: string;
  title: string;
  url: string | null;
  content: string;
  /** Cosine distance: 0 is identical, 2 is opposite. */
  distance: number;
}

export interface KnowledgeQuery {
  tenantId: string;
  embedding: number[];
  limit: number;
}

const querySchema = z.strictObject({
  tenantId: z.uuid(),
  embedding: z.array(z.number().finite()).length(knowledgeEmbeddingDimensions),
  limit: z.number().int().min(1).max(20),
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
  const { tenantId, embedding, limit } = querySchema.parse(query);
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
    distance: number;
  }>(sql`
    with nearest as materialized (
      select id, source_id, content, embedding <=> ${vector}::vector as distance
      from knowledge_chunks
      where tenant_id = ${tenantId}
      order by embedding <=> ${vector}::vector
      limit ${limit}
    )
    select n.id as "chunkId", n.source_id as "sourceId", s.title, s.url, n.content,
      n.distance
    from nearest n
    join knowledge_sources s on s.tenant_id = ${tenantId} and s.id = n.source_id
    order by n.distance, n.id`);
  return rows.map((r) => ({ ...r, distance: Number(r.distance) }));
}
