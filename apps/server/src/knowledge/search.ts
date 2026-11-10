import { type EmbeddingModel, embeddingModelId, embedTexts } from "@helpos/ai";
import {
  and,
  eq,
  inArray,
  type KnowledgeHit,
  schema,
  searchKnowledge,
  type TenantTransaction,
} from "@helpos/db";

export interface SearchQuery {
  tenantId: string;
  text: string;
  limit: number;
  /** Only these visibilities, e.g. `["public"]` for anything a customer sees unreviewed. */
  visibility?: schema.KnowledgeVisibility[] | undefined;
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
  /** `signal` aborts the embedding call (see AiBudget.spend). */
  search(
    transaction: TenantTransaction,
    query: SearchQuery,
    signal?: AbortSignal,
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
    async search(transaction, query, signal) {
      // No visibility allowed means no knowledge, not an error.
      if (query.visibility?.length === 0) return noKnowledge;
      // Most workspaces start with no knowledge (or none of the wanted visibility): skip the
      // embedding call, its cost and latency.
      const { knowledgeChunks, knowledgeSources } = schema;
      const [any] = await transaction((tx) =>
        tx
          .select({ id: knowledgeChunks.id })
          .from(knowledgeChunks)
          .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
          .where(
            and(
              eq(knowledgeChunks.embeddingModel, modelId),
              query.visibility ? inArray(knowledgeSources.visibility, query.visibility) : undefined,
            ),
          )
          .limit(1),
      );
      if (!any) return noKnowledge;
      const { embeddings, tokens } = await embedTexts(
        model,
        [query.text],
        signal ? { abortSignal: signal } : {},
      );
      try {
        const [embedding] = embeddings;
        if (!embedding) throw new Error("search: the embedding model returned no vector");
        const hits = await transaction((tx) =>
          searchKnowledge(tx, {
            tenantId: query.tenantId,
            embedding,
            embeddingModel: modelId,
            limit: query.limit,
            visibility: query.visibility,
          }),
        );
        return { hits, tokens };
      } catch (cause) {
        throw new SearchError(tokens, { cause });
      }
    },
  };
}
