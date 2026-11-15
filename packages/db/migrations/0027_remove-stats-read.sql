-- Hand-written. FORCE applies RLS to the owner too, and no tenant is set here, so the update
-- would match no rows: it is lifted for it and forced again. A token whose only scope was
-- stats:read is revoked, not deleted, so audit events still name it; a placeholder scope
-- satisfies the CHECK.
ALTER TABLE "api_tokens" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "api_tokens" SET
  "revoked_at" = CASE WHEN cardinality(array_remove("scopes", 'stats:read')) = 0 THEN coalesce("revoked_at", now()) ELSE "revoked_at" END,
  "scopes" = CASE WHEN cardinality(array_remove("scopes", 'stats:read')) = 0 THEN array['conversations:read']::text[] ELSE array_remove("scopes", 'stats:read') END
WHERE 'stats:read' = ANY("scopes");--> statement-breakpoint
ALTER TABLE "api_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scopes";--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scopes" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['conversations:read', 'conversations:write', 'drafts:write', 'drafts:approve', 'knowledge:read', 'knowledge:write']::text[]);
