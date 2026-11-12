import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, type EmbeddingModel, embedMany, RetryError } from "ai";
import { z } from "zod";
import { AiConfigError } from "./config.ts";
import { tokenBound } from "./estimate.ts";

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
 * A provider outage, a rate limit that outlasted the SDK's own retries, or a call that ran out
 * of time: worth trying again later. A wrong key, a bad request or a broken model is not, and
 * fails at once.
 */
export function isTemporaryAiFailure(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; e !== undefined && depth < 5; depth++) {
    // What AbortSignal.timeout() aborts with. The SDK passes it through as it is.
    if (e instanceof Error && e.name === "TimeoutError") return true;
    if (RetryError.isInstance(e)) return e.reason === "maxRetriesExceeded";
    if (APICallError.isInstance(e)) return e.isRetryable;
    e = e instanceof Error ? e.cause : undefined;
  }
  return false;
}

/** Texts per embedding call. Calls run one after another, so a failure knows what was spent. */
export const embedBatchSize = 64;

/** A failed embedding: earlier usage plus the failed batch bound when its cost is unknown. */
export class EmbedError extends Error {
  readonly tokens: number;
  constructor(tokens: number, options: { cause: unknown }) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`embedding failed: ${reason}`, options);
    this.name = "EmbedError";
    this.tokens = tokens;
  }
}

/**
 * Embeds texts in order, in batches of `embedBatchSize`. Fails if the model returns another
 * size than the column holds, so a misconfigured model is a clear error, not a failed insert
 * later. A failure carries earlier usage plus the failed batch bound, since it may be billed.
 */
export async function embedTexts(
  model: EmbeddingModel,
  values: string[],
  options: { abortSignal?: AbortSignal } = {},
): Promise<EmbedResult> {
  const embeddings: number[][] = [];
  let tokens = 0;
  for (let i = 0; i < values.length; i += embedBatchSize) {
    const batch = values.slice(i, i + embedBatchSize);
    let result: Awaited<ReturnType<typeof embedMany>>;
    try {
      result = await embedMany({
        // Queue retries reserve a fresh budget; hidden SDK retries could spend twice.
        maxRetries: 0,
        model,
        values: batch,
        dimensions: embeddingDimensions,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
    } catch (cause) {
      throw new EmbedError(tokens + tokenBound(...batch), { cause });
    }
    // Some OpenAI-compatible servers omit usage; keep the reserved bound as spend.
    const reported = result.usage?.tokens;
    tokens +=
      typeof reported === "number" && Number.isFinite(reported) && reported > 0
        ? reported
        : tokenBound(...batch);
    for (const e of result.embeddings) {
      if (e.length !== embeddingDimensions) {
        throw new EmbedError(tokens, {
          cause: new Error(`embedding has ${e.length} dimensions, expected ${embeddingDimensions}`),
        });
      }
    }
    embeddings.push(...result.embeddings);
  }
  return { embeddings, tokens };
}
