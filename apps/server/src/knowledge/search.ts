import { type EmbeddingModel, embeddingModelId, embedTexts, type PaidModels } from "@helpos/ai";
import {
  hasSearchableKnowledge,
  type KnowledgeHit,
  type KnowledgeQuery,
  searchKnowledge,
  type TenantTransaction,
} from "@helpos/db";

export interface SearchQuery extends Pick<KnowledgeQuery, "tenantId" | "limit" | "audience"> {
  text: string;
}

export interface SearchResult {
  hits: KnowledgeHit[];
  /** Embedding tokens spent on the query. They count toward the daily AI budget. */
  tokens: number;
}

/**
 * Finds the knowledge passages that best match a text. Database steps use the caller's
 * tenant transaction runner; embedding runs between transactions. Postgres +
 * pgvector today; another engine can implement this later without touching the callers.
 */
export interface SearchProvider {
  search(
    transaction: TenantTransaction,
    query: SearchQuery,
    models: PaidModels,
  ): Promise<SearchResult>;
}

export const noKnowledge: SearchResult = { hits: [], tokens: 0 };

/** A search that failed after its embedding call. That call was paid for, so it still counts. */
export class SearchError extends Error {
  readonly tokens: number;
  constructor(tokens: number, options: { cause: unknown }) {
    super("knowledge search failed after embedding the query", options);
    this.name = "SearchError";
    this.tokens = tokens;
  }
}

export function createVectorSearch(model: EmbeddingModel): SearchProvider {
  const modelId = embeddingModelId(model);
  return {
    async search(transaction, query, models) {
      // Most workspaces start with no knowledge (or none of the wanted visibility): skip the
      // embedding call, its cost and latency.
      const any = await transaction((tx) =>
        hasSearchableKnowledge(tx, {
          tenantId: query.tenantId,
          embeddingModel: modelId,
          audience: query.audience,
        }),
      );
      if (!any) return noKnowledge;
      const { embeddings, tokens } = await embedTexts(models(model), [query.text]);
      try {
        const [embedding] = embeddings;
        if (!embedding) throw new Error("search: the embedding model returned no vector");
        const hits = await transaction((tx) =>
          searchKnowledge(tx, {
            tenantId: query.tenantId,
            embedding,
            embeddingModel: modelId,
            limit: query.limit,
            audience: query.audience,
          }),
        );
        return { hits, tokens };
      } catch (cause) {
        throw new SearchError(tokens, { cause });
      }
    },
  };
}
