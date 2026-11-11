// Every drizzle-orm query operator (`eq`, `and`, `sql`, ...), re-exported whole so callers share
// this package's single drizzle-orm instance and a feature that needs a new one never edits this
// file. Importing `drizzle-orm` outside packages/db is a lint error.
export * from "drizzle-orm";
export {
  type AuthStore,
  createAuthStore,
  passwordSchema,
  passwordSetupTtlMs,
  type SessionAuth,
  type SessionOptions,
} from "./auth.ts";
export {
  type ApiTokenRecord,
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
  type JobDeferral,
  type JobRunner,
  type JobRunnerOptions,
  type RetryPolicy,
  type SystemJob,
  type SystemJobHandler,
  type TenantJob,
  type TenantJobHandler,
  type TenantStepsHandler,
  type TenantTransaction,
  type TenantWorker,
  tenantTransactions,
} from "./jobs.ts";
export {
  isKnowledgeUrlTaken,
  type KnowledgeHit,
  type KnowledgeQuery,
  normalizeKnowledgeUrl,
  searchKnowledge,
} from "./knowledge.ts";
export { runMigrations } from "./migrate.ts";
export * as schema from "./schema.ts";
export { uuidv7 } from "./uuid.ts";
