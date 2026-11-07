import { createOpenAI } from "@ai-sdk/openai";
import { type EmbeddingModel, embedMany } from "ai";
import { z } from "zod";
import { AiConfigError } from "./config.ts";

/**
 * The vector size every stored embedding has. Fixed, because the database column and its index
 * are. 1024 is the size most embedding models can give: OpenAI's text-embedding-3 (asked for
 * it), Voyage, Cohere, Mistral, Bedrock Titan, Gemini, and local models such as
 * mxbai-embed-large or bge-m3. A model that returns another size is refused with a clear error.
 */
export const embeddingDimensions = 1024;

export const embeddingProviders = ["openai"] as const;
export type EmbeddingProvider = (typeof embeddingProviders)[number];
export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  model: string;
  /** Absent only for a self-hosted server that needs none. */
  apiKey: string | undefined;
  /** An OpenAI-compatible server instead of OpenAI itself, e.g. Ollama. */
  baseURL: string | undefined;
};

/** An empty variable (as `.env.example` leaves them) means unset, not invalid. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const embeddingEnvSchema = z
  .object({
    AI_EMBEDDING_PROVIDER: z.enum(embeddingProviders),
    AI_EMBEDDING_MODEL: optional(z.string().min(1)),
    AI_EMBEDDING_API_KEY: optional(z.string().min(1)),
    AI_EMBEDDING_BASE_URL: optional(z.url({ protocol: /^https?$/ })),
  })
  // OpenAI itself needs a key. A local server (Ollama, LM Studio) usually doesn't.
  .refine((env) => env.AI_EMBEDDING_API_KEY || env.AI_EMBEDDING_BASE_URL, {
    path: ["AI_EMBEDDING_API_KEY"],
    message: "required unless AI_EMBEDDING_BASE_URL points at a server that needs none",
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
    model: parsed.data.AI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    apiKey: parsed.data.AI_EMBEDDING_API_KEY,
    baseURL: parsed.data.AI_EMBEDDING_BASE_URL,
  };
}

export function createEmbeddingModel(config: EmbeddingConfig): EmbeddingModel {
  switch (config.provider) {
    case "openai":
      return createOpenAI({
        // The SDK refuses to call without a key, even for a server that ignores it.
        apiKey: config.apiKey ?? "not-needed",
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      }).embedding(config.model);
  }
}

/**
 * Names the model's vector space, e.g. `openai.embedding/text-embedding-3-small`. Vectors from
 * different models can't be compared, so each stored vector records the model that made it.
 */
export function embeddingModelId(model: EmbeddingModel): string {
  return typeof model === "string" ? model : `${model.provider}/${model.modelId}`;
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
  // Some OpenAI-compatible servers report no usage. Estimate (about 4 characters a token)
  // rather than count nothing, so the daily budget still sees the spend.
  const reported = result.usage?.tokens;
  const tokens =
    typeof reported === "number" && Number.isFinite(reported) && reported > 0
      ? reported
      : Math.ceil(values.reduce((sum, v) => sum + v.length, 0) / 4);
  return { embeddings: result.embeddings, tokens };
}
