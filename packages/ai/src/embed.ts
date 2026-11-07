import { createOpenAI } from "@ai-sdk/openai";
import { type EmbeddingModel, embedMany } from "ai";
import { z } from "zod";
import { AiConfigError } from "./config.ts";

/**
 * The vector size every stored embedding has. Fixed, because the database column and its
 * index are. OpenAI's text-embedding-3 models return this size when asked.
 */
export const embeddingDimensions = 1536;

export const embeddingProviders = ["openai"] as const;
export type EmbeddingProvider = (typeof embeddingProviders)[number];
export type EmbeddingConfig = { provider: EmbeddingProvider; model: string; apiKey: string };

const embeddingEnvSchema = z.object({
  AI_EMBEDDING_PROVIDER: z.enum(embeddingProviders),
  AI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  AI_EMBEDDING_API_KEY: z.string().min(1),
});

/**
 * Reads the embedding settings from env. Separate from the chat model's, because not every
 * chat provider offers embeddings. Throws AiConfigError naming the bad variables, never values.
 */
export function parseEmbeddingConfig(env: Record<string, string | undefined>): EmbeddingConfig {
  const parsed = embeddingEnvSchema.safeParse(env);
  if (!parsed.success) {
    const vars = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new AiConfigError(`Missing or invalid embedding settings: ${vars.join(", ")}`);
  }
  return {
    provider: parsed.data.AI_EMBEDDING_PROVIDER,
    model: parsed.data.AI_EMBEDDING_MODEL,
    apiKey: parsed.data.AI_EMBEDDING_API_KEY,
  };
}

export function createEmbeddingModel(config: EmbeddingConfig): EmbeddingModel {
  switch (config.provider) {
    case "openai":
      return createOpenAI({ apiKey: config.apiKey }).embedding(config.model);
  }
}

export type EmbedResult = { embeddings: number[][]; tokens: number };

/**
 * Embeds texts in order. Fails if the model returns another size than the column holds,
 * so a misconfigured model is a clear error, not a failed insert later.
 */
export async function embedTexts(model: EmbeddingModel, values: string[]): Promise<EmbedResult> {
  if (values.length === 0) return { embeddings: [], tokens: 0 };
  const result = await embedMany({ model, values, dimensions: embeddingDimensions });
  for (const e of result.embeddings) {
    if (e.length !== embeddingDimensions) {
      throw new Error(`embedding has ${e.length} dimensions, expected ${embeddingDimensions}`);
    }
  }
  return { embeddings: result.embeddings, tokens: result.usage.tokens };
}
