// Query operators, re-exported so callers share the db package's single drizzle-orm instance.
export { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
export { type AuthStore, createAuthStore } from "./auth.ts";
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
  type JobRunner,
  type JobRunnerOptions,
  type SystemJob,
  type SystemJobHandler,
  type TenantJob,
  type TenantJobHandler,
  type TenantStepsHandler,
  type TenantTransaction,
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
export type { ApiTokenScope, KnowledgeVisibility } from "./schema.ts";
export * as schema from "./schema.ts";
export { uuidv7 } from "./uuid.ts";
