CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"repo" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"webhook_secret_ciphertext" text NOT NULL,
	CONSTRAINT "integrations_tenant_provider" UNIQUE("tenant_id","provider"),
	CONSTRAINT "integrations_provider" CHECK ("integrations"."provider" in ('github')),
	CONSTRAINT "integrations_repo_lowercase" CHECK ("integrations"."repo" = lower("integrations"."repo"))
);
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ticket_github_issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer,
	"issue_url" text,
	"state" text DEFAULT 'creating' NOT NULL,
	"closed_at" timestamp with time zone,
	"state_changed_at" timestamp with time zone,
	CONSTRAINT "ticket_github_issues_tenant_ticket" UNIQUE("tenant_id","ticket_id"),
	CONSTRAINT "ticket_github_issues_state" CHECK ("ticket_github_issues"."state" in ('creating', 'open', 'closed')),
	CONSTRAINT "ticket_github_issues_created" CHECK ("ticket_github_issues"."state" = 'creating' or ("ticket_github_issues"."issue_number" is not null and "ticket_github_issues"."issue_url" is not null)),
	CONSTRAINT "ticket_github_issues_repo_lowercase" CHECK ("ticket_github_issues"."repo" = lower("ticket_github_issues"."repo"))
);
--> statement-breakpoint
ALTER TABLE "ticket_github_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scopes";--> statement-breakpoint
DROP INDEX "drafts_tenant_message_live";--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "kind" text DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_github_issues" ADD CONSTRAINT "ticket_github_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_github_issues" ADD CONSTRAINT "ticket_github_issues_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_github_issues_tenant_issue" ON "ticket_github_issues" USING btree ("tenant_id","repo","issue_number");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_tenant_message_kind_live" ON "drafts" USING btree ("tenant_id","message_id","kind") WHERE status <> 'discarded' and not (kind = 'fixed' and status = 'sent');--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scopes" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['tickets:read', 'tickets:write', 'drafts:write', 'drafts:approve', 'knowledge:read', 'knowledge:write', 'github:write']::text[]);--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_kind" CHECK ("drafts"."kind" in ('reply', 'fixed'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "integrations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ticket_github_issues" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Hand-written: FORCE applies RLS to the table owner too (drizzle-kit cannot emit it).
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_github_issues" FORCE ROW LEVEL SECURITY;
