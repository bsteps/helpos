CREATE TABLE "http_idempotency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"response_status" integer,
	"response_body" text,
	CONSTRAINT "http_idempotency_identity" UNIQUE("tenant_id","actor_type","actor_id","key_hash"),
	CONSTRAINT "http_idempotency_actor" CHECK ("http_idempotency"."actor_type" in ('user', 'agent')),
	CONSTRAINT "http_idempotency_response" CHECK ("http_idempotency"."response_status" between 200 and 499)
);
--> statement-breakpoint
ALTER TABLE "http_idempotency" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "http_idempotency" ADD CONSTRAINT "http_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "http_idempotency" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "http_idempotency" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "http_idempotency" FROM helpos_app;
