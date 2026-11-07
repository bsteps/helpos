import { type EmbeddingModel, embedTexts } from "@helpos/ai";
import { type KnowledgeHit, schema, searchKnowledge, type TenantTx } from "@helpos/db";

export type { KnowledgeHit };

export interface SearchQuery {
  tenantId: string;
  text: string;
  limit: number;
}

export interface SearchResult {
  hits: KnowledgeHit[];
  /** Embedding tokens spent on the query. They count toward the daily AI budget. */
  tokens: number;
}

/**
 * Finds the knowledge passages that best match a text (ADR 0002). Runs inside the caller's
 * withTenant() transaction, so it can only ever see that tenant's knowledge. Postgres +
 * pgvector today; another engine can implement this later without touching the callers.
 */
export interface SearchProvider {
  search(tx: TenantTx, query: SearchQuery): Promise<SearchResult>;
}

export const noKnowledge: SearchResult = { hits: [], tokens: 0 };

export function createVectorSearch(model: EmbeddingModel): SearchProvider {
  return {
    async search(tx, query) {
      // Most workspaces start with no knowledge: skip the embedding call, its cost and latency.
      const [any] = await tx
        .select({ id: schema.knowledgeChunks.id })
        .from(schema.knowledgeChunks)
        .limit(1);
      if (!any) return noKnowledge;
      const { embeddings, tokens } = await embedTexts(model, [query.text]);
      const [embedding] = embeddings;
      if (!embedding) throw new Error("search: the embedding model returned no vector");
      const hits = await searchKnowledge(tx, {
        tenantId: query.tenantId,
        embedding,
        limit: query.limit,
      });
      return { hits, tokens };
    },
  };
}
