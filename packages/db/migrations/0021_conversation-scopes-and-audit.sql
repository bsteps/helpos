-- Hand-written. FORCE applies RLS to the owner too, and no tenant is set here, so the updates
-- would match no rows: it is lifted for them and forced again.
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_scopes";--> statement-breakpoint
ALTER TABLE "api_tokens" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "api_tokens" SET "scopes" = (
  SELECT array_agg(s ORDER BY s)
  FROM unnest(array_replace(array_replace("scopes", 'tickets:read', 'conversations:read'), 'tickets:write', 'conversations:write')) AS s
)
WHERE "scopes" && array['tickets:read', 'tickets:write']::text[];--> statement-breakpoint
ALTER TABLE "api_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_scopes" CHECK (cardinality("api_tokens"."scopes") > 0 and "api_tokens"."scopes" <@ array['conversations:read', 'conversations:write', 'drafts:write', 'drafts:approve', 'knowledge:read', 'knowledge:write', 'github:write', 'stats:read']::text[]);--> statement-breakpoint
ALTER TABLE "audit_events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "audit_events" SET "action" = 'conversation.closed' WHERE "action" = 'ticket.closed';--> statement-breakpoint
UPDATE "audit_events" SET "target_type" = 'conversation' WHERE "target_type" = 'ticket';--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
