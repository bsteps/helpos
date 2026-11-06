import { describe, expect, it } from "vitest";
import { AiConfigError, parseAiConfig } from "./config.ts";
import { createModel } from "./model.ts";

describe("parseAiConfig", () => {
  it("reads a valid config", () => {
    const env = { AI_PROVIDER: "anthropic", AI_MODEL: "claude-haiku-5-5", AI_API_KEY: "sk-test" };
    expect(parseAiConfig(env)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
  });

  it("names the bad variables without leaking values", () => {
    const env = { AI_PROVIDER: "nope", AI_MODEL: "m", AI_API_KEY: "" };
    expect(() => parseAiConfig(env)).toThrow(AiConfigError);
    expect(() => parseAiConfig(env)).toThrow("AI_PROVIDER, AI_API_KEY");
  });
});

describe("createModel", () => {
  it.each(["openai", "anthropic"] as const)(
    "builds a %s model without a network call",
    (provider) => {
      const model = createModel({ provider, model: "some-model", apiKey: "sk-test" });
      expect(typeof model === "object" && model.modelId).toBe("some-model");
    },
  );
});
