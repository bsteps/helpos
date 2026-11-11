import { AiConfigError, parseAiConfig, parseEmbeddingConfig } from "@helpos/ai";
import { z } from "zod";
import { defaultDailyTokenBudget } from "./ai-budget/budget.ts";
import { defaultPublicUrl } from "./defaults.ts";
import { parseEncryptionKey } from "./secrets/secret-box.ts";

/** Server configuration, validated once at startup. Every variable is documented in .env.example. */
export const envSchema = z
  .object({
    AI_PROVIDER: z.string().optional(),
    AI_MODEL: z.string().optional(),
    AI_API_KEY: z.string().optional(),
    AI_EMBEDDING_PROVIDER: z.string().optional(),
    AI_EMBEDDING_MODEL: z.string().optional(),
    AI_EMBEDDING_API_KEY: z.string().optional(),
    AI_EMBEDDING_BASE_URL: z.string().optional(),
    HELPOS_DATABASE_URL: z.url(),
    // The job runner connects as the jobs role. Inbound email queues a draft job, so it's required.
    HELPOS_DATABASE_JOBS_URL: z.url(),
    HELPOS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HELPOS_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    // Optional so the server still starts without it; the inbound endpoint then refuses
    // everything. Long enough that guessing it is not a realistic attack.
    HELPOS_INBOUND_SECRET: z.string().min(32).optional(),
    HELPOS_FILES_DIR: z.string().min(1).default(".data/files"),
    // Where approved replies are sent from. Optional: without it, approved drafts wait in the
    // queue until it's set. Locally smtp://localhost:1025 is Mailpit.
    HELPOS_SMTP_URL: z.url().optional(),
    // Reads owner emails for "a draft is waiting" notices. Optional: without it, notices wait.
    HELPOS_DATABASE_AUTH_URL: z.url().optional(),
    // Where the dashboard runs: links in emails point here, and browser writes from any other
    // origin are refused. Optional, default the local server.
    HELPOS_PUBLIC_URL: z.url().default(defaultPublicUrl),
    // Signs human session cookies. Optional: without it (or HELPOS_DATABASE_AUTH_URL) nobody can
    // sign in to the dashboard; agent tokens still work. Long enough that guessing is hopeless.
    HELPOS_AUTH_SECRET: z.string().min(32).optional(),
    // The built dashboard (apps/web/dist), served at /. Optional: unset, only the API is served.
    HELPOS_WEB_DIR: z.string().min(1).optional(),
    // How long a new draft waits before owners are emailed. Approved sooner, no email is sent.
    HELPOS_NOTICE_DELAY_SECONDS: z.coerce.number().int().min(0).default(300),
    // Shadow mode can only be turned off when this is "true". Unset until the release safety work
    // (set C, first real reply) ships, so no workspace can send to real customers yet.
    HELPOS_ALLOW_SHADOW_MODE_OFF: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Hard cap on AI tokens per workspace per UTC day. Over it, drafting pauses until midnight UTC.
    HELPOS_AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(defaultDailyTokenBudget),
    // Encrypts integration secrets (the GitHub token, webhook secrets) at rest: 32 bytes as hex or
    // base64. Optional: without it, no GitHub repo can be connected. The message never shows the
    // value. Changing it makes stored tokens unreadable: connect the repo again afterwards.
    HELPOS_ENCRYPTION_KEY: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v === "") return undefined;
        const key = parseEncryptionKey(v);
        if (!key) {
          ctx.addIssue({
            code: "custom",
            message: "must be 32 bytes, as 64 hex characters or base64",
          });
          return z.NEVER;
        }
        return key;
      }),
    // The GitHub API. Optional, default api.github.com; set it for GitHub Enterprise Server.
    HELPOS_GITHUB_API_URL: z.url().default("https://api.github.com"),
  })
  .transform((env, ctx) => ({
    ...env,
    ai: optionalAiConfig(
      { AI_PROVIDER: env.AI_PROVIDER, AI_MODEL: env.AI_MODEL, AI_API_KEY: env.AI_API_KEY },
      parseAiConfig,
      ctx,
    ),
    embedding: optionalAiConfig(
      {
        AI_EMBEDDING_PROVIDER: env.AI_EMBEDDING_PROVIDER,
        AI_EMBEDDING_MODEL: env.AI_EMBEDDING_MODEL,
        AI_EMBEDDING_API_KEY: env.AI_EMBEDDING_API_KEY,
        AI_EMBEDDING_BASE_URL: env.AI_EMBEDDING_BASE_URL,
      },
      parseEmbeddingConfig,
      ctx,
    ),
  }));

function optionalAiConfig<T>(
  settings: Record<string, string | undefined>,
  parse: (settings: Record<string, string | undefined>) => T,
  ctx: z.RefinementCtx,
): T | undefined {
  if (Object.values(settings).every((value) => value === undefined || value === ""))
    return undefined;
  try {
    return parse(settings);
  } catch (error) {
    if (!(error instanceof AiConfigError)) throw error;
    ctx.addIssue({ code: "custom", message: error.message });
    return undefined;
  }
}

export type Env = z.infer<typeof envSchema>;
