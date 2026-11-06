import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A company using the helpdesk. This is the root of tenancy, so it has no `tenant_id` itself.
 * Tables that belong to a tenant must have `tenant_id` and FORCE ROW LEVEL SECURITY (ADR 0003).
 */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
