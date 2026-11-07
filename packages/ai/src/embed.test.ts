import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AiConfigError } from "./config.ts";
import {
  createEmbeddingModel,
  embeddingDimensions,
  embeddingModelId,
  embedTexts,
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

  it("makes no call for no texts", async () => {
    const model = mockEmbeddingModel();
    expect(await embedTexts(model, [])).toEqual({ embeddings: [], tokens: 0 });
    expect(model.doEmbedCalls).toEqual([]);
  });
});

describe("embeddingModelId", () => {
  it("names the provider and model, so a model change is detectable", () => {
    expect(embeddingModelId(mockEmbeddingModel())).toBe("mock/mock-embedding");
    const openai = createEmbeddingModel({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
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
  it("defaults the model", () => {
    expect(
      parseEmbeddingConfig({ AI_EMBEDDING_PROVIDER: "openai", AI_EMBEDDING_API_KEY: "sk-x" }),
    ).toEqual({ provider: "openai", model: "text-embedding-3-small", apiKey: "sk-x" });
  });

  it("names the bad variables, never their values", () => {
    const env = { AI_EMBEDDING_PROVIDER: "nope-provider" };
    expect(() => parseEmbeddingConfig(env)).toThrow(AiConfigError);
    expect(() => parseEmbeddingConfig(env)).toThrow(/AI_EMBEDDING_API_KEY/);
    expect(() => parseEmbeddingConfig(env)).not.toThrow(/nope-provider/);
  });
});
