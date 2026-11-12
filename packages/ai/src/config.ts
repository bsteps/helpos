import { z } from "zod";

const aiProviders = ["openai", "anthropic"] as const;
type AiProvider = (typeof aiProviders)[number];

export type AiConfig = {
  provider: AiProvider;
  model: string;
  apiKey: string;
};

const aiEnvSchema = z.object({
  AI_PROVIDER: z.enum(aiProviders),
  AI_MODEL: z.string().min(1),
  AI_API_KEY: z.string().min(1),
});

export class AiConfigError extends Error {
  override readonly name = "AiConfigError";
}

/** Reads the AI settings from env. Throws AiConfigError naming the bad variables, never their values. */
export function parseAiConfig(env: Record<string, string | undefined>): AiConfig {
  const parsed = aiEnvSchema.safeParse(env);
  if (!parsed.success) {
    const vars = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new AiConfigError(`Missing or invalid AI settings: ${vars.join(", ")}`);
  }
  return {
    provider: parsed.data.AI_PROVIDER,
    model: parsed.data.AI_MODEL,
    apiKey: parsed.data.AI_API_KEY,
  };
}
