import { defineConfig } from "drizzle-kit";

// Only used to generate SQL migrations from the schema (`pnpm --filter @helpos/db generate`).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
