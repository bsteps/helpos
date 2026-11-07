-- Hand-written: sources added before this migration were stored as typed. Bring them to the
-- form normalizeKnowledgeUrl() stores (fragment dropped, scheme and host lowercased, default
-- port dropped, an empty path made "/"), then keep only the oldest source per page, so the
-- unique index below can be created. RLS is forced on this table, even for its owner, so it is
-- lifted for these two statements and forced again before the migration commits.
ALTER TABLE "knowledge_sources" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
WITH parts AS (
  SELECT
    id,
    lower(substring(url FROM '^([A-Za-z][A-Za-z0-9+.-]*)://')) AS scheme,
    substring(url FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?') AS prefix,
    lower(substring(url FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#]*)')) AS host,
    substring(regexp_replace(url, '#.*$', '') FROM '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*(.*)$') AS rest
  FROM "knowledge_sources"
  WHERE "kind" = 'url'
)
UPDATE "knowledge_sources" s
SET "url" = p.scheme || '://'
  || substring(p.prefix FROM '^[A-Za-z][A-Za-z0-9+.-]*://(.*)$')
  || CASE
    WHEN p.scheme = 'https' THEN regexp_replace(p.host, ':443$', '')
    WHEN p.scheme = 'http' THEN regexp_replace(p.host, ':80$', '')
    ELSE p.host
  END
  || CASE WHEN p.rest = '' OR p.rest LIKE '?%' THEN '/' || p.rest ELSE p.rest END
FROM parts p
WHERE s.id = p.id AND p.scheme IS NOT NULL;--> statement-breakpoint
-- Its passages go with it (ON DELETE CASCADE); drafts keep their copies of what they cited.
DELETE FROM "knowledge_sources" s
USING "knowledge_sources" o
WHERE s."kind" = 'url' AND o."kind" = 'url'
  AND s."tenant_id" = o."tenant_id" AND s."url" = o."url"
  AND (o."created_at", o."id") < (s."created_at", s."id");--> statement-breakpoint
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_tenant_url" ON "knowledge_sources" USING btree ("tenant_id","url") WHERE "knowledge_sources"."kind" = 'url';
