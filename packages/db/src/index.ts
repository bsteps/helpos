// Every drizzle-orm query operator (`eq`, `and`, `sql`, ...), re-exported whole so callers share
// this package's single drizzle-orm instance and a feature that needs a new one never edits this
// file. Importing `drizzle-orm` outside packages/db is a lint error.
export * from "drizzle-orm";
export {
  type AuthStore,
  createAuthStore,
  passwordSchema,
  type SessionAuth,
} from "./auth.ts";
export {
  type ApiTokenRecord,
  createDatabase,
  type Database,
  type TenantTx,
} from "./client.ts";
export { isUniqueViolation } from "./errors.ts";
export {
  createJobRunner,
  defineTenantJob,
  enqueue,
  type JobDeferral,
  type JobRunner,
  type RetryPolicy,
  type TenantJob,
  type TenantJobHandler,
  type TenantStepsHandler,
  type TenantTransaction,
  tenantTransactions,
} from "./jobs.ts";
export {
  hasSearchableKnowledge,
  isKnowledgeUrlTaken,
  type KnowledgeHit,
  normalizeKnowledgeUrl,
  searchKnowledge,
} from "./knowledge.ts";
export * as schema from "./schema.ts";
export { uuidv7 } from "./uuid.ts";
