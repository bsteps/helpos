// Query operators, re-exported so callers share the db package's single drizzle-orm instance.
export { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
export { type AuthStore, createAuthStore } from "./auth.ts";
export {
  createDatabase,
  type Database,
  type MailboxRoute,
  type MembershipSummary,
  type PingResult,
  type TenantTx,
} from "./client.ts";
export { isUniqueViolation } from "./errors.ts";
export {
  createJobRunner,
  defineSystemJob,
  defineTenantJob,
  type EnqueueOptions,
  enqueue,
  installJobs,
  type JobRunner,
  type JobRunnerOptions,
  type SystemJob,
  type SystemJobHandler,
  type TenantJob,
  type TenantJobHandler,
} from "./jobs.ts";
export { runMigrations } from "./migrate.ts";
export * as schema from "./schema.ts";
export { uuidv7 } from "./uuid.ts";
