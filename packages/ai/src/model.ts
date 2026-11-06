import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AiConfig } from "./config.ts";

/**
 * The one place that turns config into a model (ADR 0002: provider-agnostic, bring your own key).
 * Features take a LanguageModel as a parameter, so tests can pass the mock instead.
 */
export function createModel(config: AiConfig): LanguageModel {
  switch (config.provider) {
    case "openai":
      return createOpenAI({ apiKey: config.apiKey })(config.model);
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey })(config.model);
  }
}
