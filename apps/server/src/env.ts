import { z } from "zod";

/** Server configuration, validated once at startup. Every variable is documented in .env.example. */
export const envSchema = z.object({
  HELPOS_DATABASE_URL: z.url(),
  HELPOS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HELPOS_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;
