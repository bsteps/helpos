ALTER TABLE "knowledge_sources" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "state" jsonb;
ALTER TABLE "knowledge_sources" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Old rows never recorded their retry timestamp. Migration time is a metadata fallback;
-- the existing pg-boss jobs remain authoritative for scheduling and are not changed.
UPDATE "knowledge_sources"
SET "state" = CASE
  WHEN "status" IN ('pending', 'ready') AND "error" IS NULL
    THEN jsonb_build_object('status', "status")
  ELSE jsonb_build_object(
    'status', CASE WHEN "status" = 'pending' THEN 'waiting' ELSE "status" END,
    'reason', CASE WHEN "error" ~ '^http_[1-9][0-9]{2}$'
      THEN jsonb_build_object('code', 'http_error', 'status', substring("error" FROM 6)::integer)
      ELSE jsonb_build_object('code', "error") END
  ) || CASE WHEN "status" = 'pending'
    THEN jsonb_build_object('retryAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    ELSE '{}'::jsonb END
END,
"retry_count" = CASE WHEN "status" = 'pending' AND "error" IN (
  'timeout', 'network', 'embedding_unavailable', 'http_408', 'http_425', 'http_429',
  'http_500', 'http_502', 'http_503', 'http_504'
) THEN 1 ELSE 0 END;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ALTER COLUMN "state" SET NOT NULL;
ALTER TABLE "knowledge_sources" ALTER COLUMN "state" SET DEFAULT '{"status":"pending"}'::jsonb;
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_retry_count" CHECK ("retry_count" >= 0);
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_state" CHECK (COALESCE(
  jsonb_typeof("state") = 'object' AND CASE "state"->>'status'
    WHEN 'pending' THEN "state" = '{"status":"pending"}'::jsonb
    WHEN 'ready' THEN "state" = '{"status":"ready"}'::jsonb
    WHEN 'failed' THEN
      "state" - 'status' - 'reason' = '{}'::jsonb AND
      jsonb_typeof("state"->'reason') = 'object' AND CASE
        WHEN "state"->'reason'->>'code' = 'http_error' THEN
          ("state"->'reason') - 'code' - 'status' = '{}'::jsonb AND
          jsonb_typeof("state"->'reason'->'status') = 'number' AND
          ("state"->'reason'->>'status') ~ '^[1-9][0-9]{2}$'
        ELSE ("state"->'reason') - 'code' = '{}'::jsonb AND
          "state"->'reason'->>'code' IN (
            'invalid_url', 'blocked_address', 'blocked_port', 'insecure_redirect', 'dns_failed',
            'timeout', 'aborted', 'too_large', 'too_many_redirects', 'network', 'no_url',
            'no_text', 'too_long', 'unsupported_content_type', 'embedding_unavailable',
            'embedding_failed', 'ingest_error') END
    WHEN 'waiting' THEN
      "state" - 'status' - 'reason' - 'retryAt' = '{}'::jsonb AND
      jsonb_typeof("state"->'reason') = 'object' AND
      jsonb_typeof("state"->'retryAt') = 'string' AND
      CASE WHEN ("state"->>'retryAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
        THEN ("state"->>'retryAt')::timestamptz IS NOT NULL ELSE false END AND CASE
        WHEN "state"->'reason'->>'code' = 'http_error' THEN
          ("state"->'reason') - 'code' - 'status' = '{}'::jsonb AND
          jsonb_typeof("state"->'reason'->'status') = 'number' AND
          ("state"->'reason'->>'status') IN ('408', '425', '429', '500', '502', '503', '504')
        ELSE ("state"->'reason') - 'code' = '{}'::jsonb AND
          "state"->'reason'->>'code' IN ('timeout', 'network', 'embedding_unavailable', 'daily_budget_reached') END
    ELSE false END, false));--> statement-breakpoint
ALTER TABLE "knowledge_sources" DROP CONSTRAINT "knowledge_sources_status";
ALTER TABLE "knowledge_sources" DROP COLUMN "status";
ALTER TABLE "knowledge_sources" DROP COLUMN "error";
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;
