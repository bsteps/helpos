import { RetryError } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { embeddingDimensions } from "./embed.ts";

export type MockToolCall = { toolName: string; input: Record<string, unknown> };
export type MockResponse = {
  text?: string | undefined;
  toolCalls?: MockToolCall[] | undefined;
  /** Tokens the mock reports per call, e.g. to test spend caps. Zero by default. */
  usage?: { inputTokens: number; outputTokens: number } | undefined;
};

/**
 * A model that returns a scripted response and never touches the network.
 * Every unit, integration and CI eval run uses this: CI never calls a real provider.
 */
export function mockModel(response: MockResponse = {}): MockLanguageModelV4 {
  const toolCalls = response.toolCalls ?? [];
  const input = response.usage?.inputTokens ?? 0;
  const output = response.usage?.outputTokens ?? 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-model",
    doGenerate: {
      content: [
        ...(response.text === undefined ? [] : [{ type: "text" as const, text: response.text }]),
        ...toolCalls.map((call, i) => ({
          type: "tool-call" as const,
          toolCallId: `mock-call-${i}`,
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        })),
      ],
      finishReason: { unified: toolCalls.length > 0 ? "tool-calls" : "stop", raw: undefined },
      usage: {
        inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

/** What the SDK throws once its own retries of a 429 or a 503 have run out. */
export function providerDownError(): RetryError {
  return new RetryError({
    message: "failed after 3 attempts",
    reason: "maxRetriesExceeded",
    errors: [],
  });
}

/** A model whose every call fails, like a provider outage. */
export function failingModel(message = "503 service unavailable"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "failing-model",
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** FNV-1a: a stable bucket per word, the same on every run and machine. */
function bucket(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % embeddingDimensions;
}

/**
 * A bag-of-words vector: texts that share words point the same way. Crude, but deterministic
 * and offline, which is what retrieval tests need. Never all zeros (cosine distance needs a length).
 */
export function mockEmbedding(text: string): number[] {
  const v = new Array<number>(embeddingDimensions).fill(0);
  const all = words(text);
  for (const w of all) v[bucket(w)] = (v[bucket(w)] ?? 0) + 1;
  if (all.length === 0) v[0] = 1;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** An embedding model that uses mockEmbedding() and reports one token per word. */
export function mockEmbeddingModel(modelId = "mock-embedding"): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: "mock",
    modelId,
    maxEmbeddingsPerCall: 100,
    doEmbed: async ({ values }) => ({
      embeddings: values.map(mockEmbedding),
      usage: { tokens: values.reduce((n, v) => n + words(v).length, 0) },
      warnings: [],
    }),
  });
}
