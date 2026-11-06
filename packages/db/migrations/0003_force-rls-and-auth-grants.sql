-- ADR 0003: FORCE applies RLS to the table owner too. drizzle-kit can't emit this, so every new
-- tenant table needs a line here (or in a later migration). schema.test.ts fails if one is missing.
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attachments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- ADR 0009 §1: only the auth role may use the auth schema. The app role gets nothing here.
REVOKE ALL ON SCHEMA "auth" FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "auth" TO helpos_auth;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" TO helpos_auth;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "auth" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpos_auth;
