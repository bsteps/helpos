import { z } from "zod";
import { installJobs } from "./jobs.ts";
import { runMigrations } from "./migrate.ts";

const env = z
  .object({ HELPOS_DATABASE_OWNER_URL: z.url(), HELPOS_DATABASE_JOBS_URL: z.url() })
  .parse(process.env);
await runMigrations(env.HELPOS_DATABASE_OWNER_URL);
// pg-boss tables and app_enqueue() belong to the jobs role, so they install as that role.
await installJobs(env.HELPOS_DATABASE_JOBS_URL);
process.stdout.write("Migrations applied.\n");
