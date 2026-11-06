import { z } from "zod";

/** Server configuration, validated once at startup. Every variable is documented in .env.example. */
export const envSchema = z.object({
  HELPOS_DATABASE_URL: z.url(),
  HELPOS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HELPOS_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  // Optional so the server still starts without it; the inbound endpoint then refuses
  // everything. Long enough that guessing it is not a realistic attack.
  HELPOS_INBOUND_SECRET: z.string().min(32).optional(),
  HELPOS_FILES_DIR: z.string().min(1).default(".data/files"),
});

export type Env = z.infer<typeof envSchema>;
