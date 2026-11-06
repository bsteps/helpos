import { z } from "zod";
import { runMigrations } from "./migrate.ts";

const env = z.object({ HELPOS_DATABASE_OWNER_URL: z.url() }).parse(process.env);
await runMigrations(env.HELPOS_DATABASE_OWNER_URL);
process.stdout.write("Migrations applied.\n");
