CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "api_tokens_token_hash_format" CHECK ("api_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_tokens_scopes" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['tickets:read', 'drafts:write', 'drafts:approve', 'knowledge:read', 'knowledge:write']::text[])
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_tokens" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "resolve_by_token_hash" ON "api_tokens" AS PERMISSIVE FOR SELECT TO public USING (token_hash = nullif(current_setting('app.token_hash', true), ''));--> statement-breakpoint
-- Hand-written: FORCE applies RLS to the table owner too (drizzle-kit cannot emit it).
ALTER TABLE "api_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Tokens are revoked, never deleted, and the app can change nothing but the revocation: a bug
-- in the app can't rewrite a token's hash or widen its scopes.
REVOKE UPDATE, DELETE, TRUNCATE ON "api_tokens" FROM helpos_app;--> statement-breakpoint
GRANT UPDATE ("revoked_at", "updated_at") ON "api_tokens" TO helpos_app;
