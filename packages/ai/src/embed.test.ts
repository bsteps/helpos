import { APICallError, RetryError } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AiConfigError } from "./config.ts";
import {
  createEmbeddingModel,
  EmbedError,
  embedBatchSize,
  embeddingDimensions,
  embeddingModelId,
  embedTexts,
  isTemporaryAiFailure,
  parseEmbeddingConfig,
} from "./embed.ts";
import { mockEmbedding, mockEmbeddingModel } from "./testing.ts";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("embedTexts", () => {
  it("returns one vector per text, in order, with the token count", async () => {
    const result = await embedTexts(mockEmbeddingModel(), ["refund policy", "shipping times"]);
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toHaveLength(embeddingDimensions);
    expect(result.tokens).toBe(4);
  });

  it("asks for the stored size, and fails on a model that returns another", async () => {
    const wrong = new MockEmbeddingModelV4({
      doEmbed: async () => ({ embeddings: [[1, 2, 3]], warnings: [] }),
    });
    await expect(embedTexts(wrong, ["x"])).rejects.toThrow(/3 dimensions/);
    expect(wrong.doEmbedCalls[0]?.dimensions).toBe(embeddingDimensions);
  });

  it("estimates the tokens when the server reports no usage", async () => {
    const silent = new MockEmbeddingModelV4({
      doEmbed: async () => ({
        embeddings: [new Array(embeddingDimensions).fill(0.1)],
        warnings: [],
      }),
    });
    expect((await embedTexts(silent, ["x".repeat(40)])).tokens).toBe(10);
  });

  it("makes no call for no texts", async () => {
    const model = mockEmbeddingModel();
    expect(await embedTexts(model, [])).toEqual({ embeddings: [], tokens: 0 });
    expect(model.doEmbedCalls).toEqual([]);
  });

  it("embeds in batches, in order", async () => {
    const model = mockEmbeddingModel();
    const texts = Array.from({ length: embedBatchSize * 2 + 1 }, (_, i) => `text ${i}`);
    const { embeddings } = await embedTexts(model, texts);
    expect(model.doEmbedCalls.map((c) => c.values.length)).toEqual([
      embedBatchSize,
      embedBatchSize,
      1,
    ]);
    expect(embeddings[embedBatchSize * 2]).toEqual(mockEmbedding(`text ${embedBatchSize * 2}`));
  });

  it("reports what the batches before a failure cost, so the spend still counts", async () => {
    let calls = 0;
    const flaky = new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 1_000,
      doEmbed: async ({ values }) => {
        if (++calls > 1) throw new Error("429 rate limited");
        return {
          embeddings: values.map(() => new Array(embeddingDimensions).fill(0.1)),
          usage: { tokens: 50 },
          warnings: [],
        };
      },
    });
    const texts = Array.from({ length: embedBatchSize + 1 }, () => "x");
    const error = await embedTexts(flaky, texts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbedError);
    expect(error).toMatchObject({ tokens: 50 });
  });
});

describe("embeddingModelId", () => {
  it("names the provider and model, so a model change is detectable", () => {
    expect(embeddingModelId(mockEmbeddingModel())).toBe("mock/mock-embedding");
    const openai = createEmbeddingModel({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
      baseURL: undefined,
    });
    expect(embeddingModelId(openai)).toBe("openai.embedding/text-embedding-3-small");
  });
});

describe("mockEmbedding", () => {
  it("points texts that share words the same way", () => {
    const refund = mockEmbedding("How long do refunds take?");
    expect(cosine(refund, mockEmbedding("Refund policy: refunds take 5 days"))).toBeGreaterThan(
      cosine(refund, mockEmbedding("Shipping times for orders")),
    );
  });

  it("is a unit vector, even for text with no words", () => {
    expect(Math.hypot(...mockEmbedding("hello world"))).toBeCloseTo(1);
    expect(Math.hypot(...mockEmbedding("!!"))).toBeCloseTo(1);
  });
});

describe("parseEmbeddingConfig", () => {
  it("defaults the model, and treats empty variables as unset", () => {
    expect(
      parseEmbeddingConfig({
        AI_EMBEDDING_PROVIDER: "openai",
        AI_EMBEDDING_API_KEY: "sk-x",
        AI_EMBEDDING_MODEL: "",
        AI_EMBEDDING_BASE_URL: "",
      }),
    ).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-x",
      baseURL: undefined,
    });
  });

  it("needs no key for a self-hosted OpenAI-compatible server", () => {
    expect(
      parseEmbeddingConfig({
        AI_EMBEDDING_PROVIDER: "openai",
        AI_EMBEDDING_MODEL: "mxbai-embed-large",
        AI_EMBEDDING_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toEqual({
      provider: "openai",
      model: "mxbai-embed-large",
      apiKey: undefined,
      baseURL: "http://localhost:11434/v1",
    });
  });

  it("needs a key for OpenAI itself", () => {
    expect(() => parseEmbeddingConfig({ AI_EMBEDDING_PROVIDER: "openai" })).toThrow(
      /AI_EMBEDDING_API_KEY/,
    );
  });

  it("refuses a base URL that isn't http(s)", () => {
    expect(() =>
      parseEmbeddingConfig({
        AI_EMBEDDING_PROVIDER: "openai",
        AI_EMBEDDING_BASE_URL: "file:///etc/passwd",
      }),
    ).toThrow(/AI_EMBEDDING_BASE_URL/);
  });

  it("names the bad variables, never their values", () => {
    const env = { AI_EMBEDDING_PROVIDER: "nope-provider", AI_EMBEDDING_API_KEY: "sk-secret" };
    expect(() => parseEmbeddingConfig(env)).toThrow(AiConfigError);
    expect(() => parseEmbeddingConfig(env)).toThrow(/AI_EMBEDDING_PROVIDER/);
    expect(() => parseEmbeddingConfig(env)).not.toThrow(/nope-provider|sk-secret/);
  });
});

describe("createEmbeddingModel", () => {
  it("sends requests to the configured OpenAI-compatible server, asking for 1024", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { object: "embedding", embedding: new Array(embeddingDimensions).fill(0.1), index: 0 },
          ],
          model: "mxbai-embed-large",
          usage: { prompt_tokens: 2, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    try {
      const model = createEmbeddingModel({
        provider: "openai",
        model: "mxbai-embed-large",
        apiKey: undefined,
        baseURL: "http://localhost:11434/v1",
      });
      const result = await embedTexts(model, ["hello"]);
      expect(result.embeddings[0]).toHaveLength(embeddingDimensions);
    } finally {
      globalThis.fetch = original;
    }
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/embeddings");
    expect(calls[0]?.body).toMatchObject({ model: "mxbai-embed-large", dimensions: 1024 });
  });
});

describe("isTemporaryAiFailure", () => {
  const apiError = (statusCode: number, isRetryable: boolean) =>
    new APICallError({
      message: `HTTP ${statusCode}`,
      url: "https://api.example.test/v1/embeddings",
      requestBodyValues: {},
      statusCode,
      isRetryable,
    });

  it("is true for an outage or rate limit that outlasted the retries, even wrapped", () => {
    const retried = new RetryError({
      message: "failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiError(503, true)],
    });
    expect(isTemporaryAiFailure(retried)).toBe(true);
    expect(isTemporaryAiFailure(new EmbedError(0, { cause: retried }))).toBe(true);
    expect(isTemporaryAiFailure(apiError(429, true))).toBe(true);
  });

  it("is false for a wrong key, a bad request or an unknown error", () => {
    expect(isTemporaryAiFailure(apiError(401, false))).toBe(false);
    expect(
      isTemporaryAiFailure(
        new RetryError({
          message: "x",
          reason: "errorNotRetryable",
          errors: [apiError(400, false)],
        }),
      ),
    ).toBe(false);
    expect(isTemporaryAiFailure(new Error("dimensions"))).toBe(false);
  });
});
