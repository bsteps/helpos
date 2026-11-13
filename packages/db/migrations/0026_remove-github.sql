-- Hand-written. FORCE applies RLS to the owner too, and no tenant is set here, so the changes
-- would match no rows: it is lifted for them and forced again. "fixed" notices go before the
-- one-live-draft-per-message index returns. A token whose only scope was github:write is revoked,
-- not deleted, so audit events still name it; it keeps the narrowest scope to satisfy the CHECK.
ALTER TABLE "drafts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_citations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM "draft_citations" WHERE "draft_id" IN (SELECT "id" FROM "drafts" WHERE "kind" = 'fixed');--> statement-breakpoint
DELETE FROM "drafts" WHERE "kind" = 'fixed';--> statement-breakpoint
UPDATE "api_tokens" SET
  "revoked_at" = CASE WHEN cardinality(array_remove("scopes", 'github:write')) = 0 THEN coalesce("revoked_at", now()) ELSE "revoked_at" END,
  "scopes" = CASE WHEN cardinality(array_remove("scopes", 'github:write')) = 0 THEN array['conversations:read']::text[] ELSE array_remove("scopes", 'github:write') END
WHERE 'github:write' = ANY("scopes");--> statement-breakpoint
ALTER TABLE "drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "draft_citations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_github_issues" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "conversation_github_issues" CASCADE;--> statement-breakpoint
DROP TABLE "conversation_github_issues" CASCADE;--> statement-breakpoint
DROP POLICY "tenant_isolation" ON "integrations" CASCADE;--> statement-breakpoint
DROP TABLE "integrations" CASCADE;--> statement-breakpoint
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scopes";--> statement-breakpoint
ALTER TABLE "drafts" DROP CONSTRAINT "drafts_kind";--> statement-breakpoint
DROP INDEX "drafts_tenant_message_kind_live";--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_tenant_message_live" ON "drafts" USING btree ("tenant_id","message_id") WHERE status <> 'discarded';--> statement-breakpoint
ALTER TABLE "drafts" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scopes" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['conversations:read', 'conversations:write', 'drafts:write', 'drafts:approve', 'knowledge:read', 'knowledge:write', 'stats:read']::text[]);