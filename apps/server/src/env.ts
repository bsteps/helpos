import { z } from "zod";
import { defaultDailyTokenBudget } from "./ai-budget/budget.ts";

/** Server configuration, validated once at startup. Every variable is documented in .env.example. */
export const envSchema = z.object({
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
  // Where links in emails point (the dashboard). Optional, default the local server.
  HELPOS_PUBLIC_URL: z.url().default("http://localhost:3000"),
  // How long a new draft waits before owners are emailed. Approved sooner, no email is sent.
  HELPOS_NOTICE_DELAY_SECONDS: z.coerce.number().int().min(0).default(300),
  // Shadow mode can only be turned off when this is "true". Unset until the release safety work
  // (Set 2a) ships, so no workspace can send to real customers yet.
  HELPOS_ALLOW_SHADOW_MODE_OFF: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Hard cap on AI tokens per workspace per UTC day. Over it, drafting pauses until midnight UTC.
  HELPOS_AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().min(0).default(defaultDailyTokenBudget),
});

export type Env = z.infer<typeof envSchema>;
