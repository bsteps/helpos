CREATE TABLE "draft_citations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"draft_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"cited" boolean NOT NULL,
	CONSTRAINT "draft_citations_tenant_draft_chunk" UNIQUE("tenant_id","draft_id","chunk_id")
);
--> statement-breakpoint
ALTER TABLE "draft_citations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text NOT NULL,
	CONSTRAINT "knowledge_chunks_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"content" text,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone,
	"embedding_model" text,
	"managed_by" text DEFAULT 'app' NOT NULL,
	"source_path" text,
	"source_commit" text,
	CONSTRAINT "knowledge_sources_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "knowledge_sources_tenant_slug" UNIQUE("tenant_id","slug"),
	CONSTRAINT "knowledge_sources_kind" CHECK ("knowledge_sources"."kind" in ('url', 'markdown')),
	CONSTRAINT "knowledge_sources_status" CHECK ("knowledge_sources"."status" in ('pending', 'ready', 'failed')),
	CONSTRAINT "knowledge_sources_visibility" CHECK ("knowledge_sources"."visibility" in ('public', 'internal')),
	CONSTRAINT "knowledge_sources_managed_by" CHECK ("knowledge_sources"."managed_by" in ('app', 'git')),
	CONSTRAINT "knowledge_sources_git_path" CHECK ("knowledge_sources"."managed_by" = 'app' or "knowledge_sources"."source_path" is not null),
	CONSTRAINT "knowledge_sources_url" CHECK ("knowledge_sources"."kind" <> 'url' or "knowledge_sources"."url" is not null),
	CONSTRAINT "knowledge_sources_content" CHECK ("knowledge_sources"."kind" <> 'markdown' or "knowledge_sources"."content" is not null)
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_citations" ADD CONSTRAINT "draft_citations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_citations" ADD CONSTRAINT "draft_citations_draft_fk" FOREIGN KEY ("tenant_id","draft_id") REFERENCES "public"."drafts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_citations" ADD CONSTRAINT "draft_citations_chunk_fk" FOREIGN KEY ("tenant_id","chunk_id") REFERENCES "public"."knowledge_chunks"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."knowledge_sources"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tenant_source" ON "knowledge_chunks" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "draft_citations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_chunks" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_sources" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Hand-written: FORCE applies RLS to the table owner too (drizzle-kit cannot emit it).
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_citations" FORCE ROW LEVEL SECURITY;
