import { type EmbeddingModel, embeddingModelId, embedTexts } from "@helpos/ai";
import {
  eq,
  type KnowledgeHit,
  type KnowledgeVisibility,
  schema,
  searchKnowledge,
  type TenantTx,
} from "@helpos/db";

export type { KnowledgeHit };

export interface SearchQuery {
  tenantId: string;
  text: string;
  limit: number;
  /** Only these visibilities, e.g. `["public"]` for anything a customer sees unreviewed. */
  visibility?: KnowledgeVisibility[] | undefined;
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
  const modelId = embeddingModelId(model);
  return {
    async search(tx, query) {
      // Most workspaces start with no knowledge: skip the embedding call, its cost and latency.
      const [any] = await tx
        .select({ id: schema.knowledgeChunks.id })
        .from(schema.knowledgeChunks)
        .where(eq(schema.knowledgeChunks.embeddingModel, modelId))
        .limit(1);
      if (!any) return noKnowledge;
      const { embeddings, tokens } = await embedTexts(model, [query.text]);
      const [embedding] = embeddings;
      if (!embedding) throw new Error("search: the embedding model returned no vector");
      const hits = await searchKnowledge(tx, {
        tenantId: query.tenantId,
        embedding,
        embeddingModel: modelId,
        limit: query.limit,
        visibility: query.visibility,
      });
      return { hits, tokens };
    },
  };
}
