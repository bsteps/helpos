import { asc, type Database, enqueue, eq, isUniqueViolation, schema, uuidv7 } from "@helpos/db";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { recordAudit } from "../audit/audit.ts";
import { type Authenticate, requirePrincipal } from "../auth/principal.ts";
import { ingestSourceJob } from "./jobs.ts";

const { knowledgeSources } = schema;
type SourceRow = typeof knowledgeSources.$inferSelect;

export interface KnowledgeRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
}

/** Lowercase words joined by `-`, optionally in `/` folders, so it can become a file path. */
const slugSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/)
  .openapi({ example: "billing/refunds" });
const titleSchema = z.string().trim().min(1).max(300);

/** Large enough for a long help article, small enough to bound one ingest's embedding cost. */
export const maxMarkdownChars = 200_000;

const createBody = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("url"),
    title: titleSchema,
    url: z.url({ protocol: /^https?$/ }).max(2_000),
    slug: slugSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("markdown"),
    title: titleSchema,
    content: z.string().trim().min(1).max(maxMarkdownChars),
    slug: slugSchema.optional(),
  }),
]);

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const sourceSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    kind: z.enum(schema.knowledgeSourceKinds),
    title: z.string(),
    url: z.string().nullable(),
    /** `pending` until the ingest job has run, then `ready` or `failed`. */
    status: z.enum(schema.knowledgeSourceStatuses),
    /** Why ingestion failed, e.g. `blocked_address`, `http_404`, `no_text`. */
    error: z.string().nullable(),
    chunkCount: z.number().int(),
    /** `git` items are changed in the workspace's repo, never through this API. */
    managedBy: z.enum(schema.managedByValues),
    sourcePath: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    ingestedAt: z.iso.datetime().nullable(),
  })
  .openapi("KnowledgeSource");

const idParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });
const json = <T extends z.ZodType>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});
const authErrors = {
  401: json(errorSchema, "No valid credentials"),
  403: json(errorSchema, "The credentials lack the required scope"),
};
const security = [{ apiAuth: [] }];

const listRoute = createRoute({
  method: "get",
  path: "/v1/knowledge/sources",
  summary: "List knowledge sources",
  description:
    "Every knowledge source in the workspace, oldest first, with its ingestion status. " +
    "Needs `knowledge:read`.",
  security,
  responses: {
    200: json(z.object({ sources: z.array(sourceSchema) }), "The sources"),
    ...authErrors,
  },
});

const createSourceRoute = createRoute({
  method: "post",
  path: "/v1/knowledge/sources",
  summary: "Add a knowledge source",
  description:
    "Adds a web page (`kind: url`) or a markdown document (`kind: markdown`; to upload a " +
    "file, send its text). It is ingested in the background: fetched through an SSRF-safe " +
    "fetch, split into passages and embedded, which counts toward the daily AI budget. The " +
    "status turns `ready` or `failed`. AI drafts then quote matching passages as reference " +
    "data and record which ones they cite. One page per URL source: links are not followed. " +
    "`slug` defaults to one made from the title. Needs `knowledge:write`.",
  security,
  request: {
    body: { required: true, content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: json(sourceSchema, "The new source, status `pending`"),
    ...authErrors,
    409: json(errorSchema, "The workspace already has a source with this slug (`slug_taken`)"),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/knowledge/sources/{id}",
  summary: "Delete a knowledge source",
  description:
    "Deletes the source and its passages. Drafts stop listing it among their sources. " +
    "Needs `knowledge:write`.",
  security,
  request: { params: idParams },
  responses: {
    204: { description: "Deleted" },
    ...authErrors,
    404: json(errorSchema, "Not found in this workspace"),
    409: json(
      errorSchema,
      "The source is managed in the workspace's git repo (`managed_in_git`): delete the file there",
    ),
  },
});

function serialize(s: SourceRow): z.infer<typeof sourceSchema> {
  return {
    id: s.id,
    slug: s.slug,
    kind: s.kind,
    title: s.title,
    url: s.url,
    status: s.status,
    error: s.error,
    chunkCount: s.chunkCount,
    managedBy: s.managedBy,
    sourcePath: s.sourcePath,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    ingestedAt: s.ingestedAt?.toISOString() ?? null,
  };
}

/** A slug from a title: "Refunds & Returns!" becomes "refunds-returns". */
export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

export function registerKnowledgeRoutes(app: OpenAPIHono, deps: KnowledgeRoutesDeps): void {
  app.use("/v1/knowledge/*", requirePrincipal(deps.authenticate));

  app.openapi(listRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("knowledge:read")) return c.json({ error: "forbidden" }, 403);
    const rows = await deps.db.withTenant(principal.tenantId, (tx) =>
      tx
        .select()
        .from(knowledgeSources)
        .orderBy(asc(knowledgeSources.createdAt), asc(knowledgeSources.id)),
    );
    return c.json({ sources: rows.map(serialize) }, 200);
  });

  app.openapi(createSourceRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("knowledge:write")) return c.json({ error: "forbidden" }, 403);
    const input = c.req.valid("json");
    const { tenantId, actor } = principal;
    const id = uuidv7();
    // A title with no Latin letters or digits still gets a stable, unique slug.
    const slug = input.slug ?? (slugify(input.title) || `source-${id.slice(-12)}`);

    try {
      const source = await deps.db.withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .insert(knowledgeSources)
          .values({
            id,
            tenantId,
            slug,
            kind: input.kind,
            title: input.title,
            url: input.kind === "url" ? input.url : null,
            content: input.kind === "markdown" ? input.content : null,
          })
          .returning();
        if (!row) throw new Error("create knowledge source: insert returned no row");
        await recordAudit(tx, {
          tenantId,
          actor,
          action: "knowledge_source.created",
          target: { type: "knowledge_source", id },
          requestId: c.get("requestId"),
        });
        // In the same transaction: the source and its ingest job exist together or not at all.
        await enqueue(tx, ingestSourceJob, { tenantId, sourceId: id }, { singletonKey: id });
        return row;
      });
      return c.json(serialize(source), 201);
    } catch (error) {
      // Per workspace (ADR 0009 §7): this says nothing about other workspaces' slugs.
      if (isUniqueViolation(error, "knowledge_sources_tenant_slug")) {
        return c.json({ error: "slug_taken" }, 409);
      }
      throw error;
    }
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal.scopes.has("knowledge:write")) return c.json({ error: "forbidden" }, 403);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [found] = await tx
        .select({ managedBy: knowledgeSources.managedBy })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, id))
        .for("update");
      // Another workspace's source looks exactly like one that doesn't exist.
      if (!found) return "not_found" as const;
      // ADR 0010 §3: git owns these rows; the API never writes them.
      if (found.managedBy === "git") return "managed_in_git" as const;
      // Its chunks, and drafts' citations of them, go with it (ON DELETE CASCADE).
      await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "knowledge_source.deleted",
        target: { type: "knowledge_source", id },
        requestId: c.get("requestId"),
      });
      return "deleted" as const;
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    if (result === "managed_in_git") return c.json({ error: "managed_in_git" }, 409);
    return c.body(null, 204);
  });
}
