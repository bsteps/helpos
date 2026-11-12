import { asc, type Database, schema } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiRoute } from "../auth/access.ts";
import {
  auditor,
  errorResponse,
  errorSchema,
  idParams,
  json,
  jsonBody,
  notFound,
  notFoundResponse,
} from "../http/route-kit.ts";
import { createSource, deleteSource, requestIngest, updateSource } from "./sources.ts";

const { knowledgeSources } = schema;
type SourceRow = typeof knowledgeSources.$inferSelect;

export interface KnowledgeRoutesDeps {
  db: Pick<Database, "withTenant">;
}

/** Lowercase words joined by `-`, optionally in `/` folders, so it can become a file path. */
const slugSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/)
  .openapi({ example: "billing/refunds" });
/** Postgres can't store NUL in text, so it's refused here rather than failing the insert. */
const noNul = (s: string) => !s.includes(String.fromCharCode(0));
const nulMessage = "must not contain NUL characters";
const titleSchema = z.string().trim().min(1).max(300).refine(noNul, nulMessage);
const visibilitySchema = z.enum(schema.knowledgeVisibilities).openapi({
  description:
    "`public` may be shown or cited to customers. `internal` (the default) is the team's own " +
    "notes: AI drafts may follow it, but are told never to reveal it.",
});

/** Large enough for a long help article, small enough to bound one ingest's embedding cost. */
const maxMarkdownChars = 200_000;

const createBody = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("url"),
    title: titleSchema,
    url: z.url({ protocol: /^https?$/ }).max(2_000),
    slug: slugSchema.optional(),
    visibility: visibilitySchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("markdown"),
    title: titleSchema,
    content: z.string().trim().min(1).max(maxMarkdownChars).refine(noNul, nulMessage),
    slug: slugSchema.optional(),
    visibility: visibilitySchema.optional(),
  }),
]);

const updateBody = z
  .strictObject({
    title: titleSchema.optional(),
    visibility: visibilitySchema.optional(),
    content: z
      .string()
      .trim()
      .min(1)
      .max(maxMarkdownChars)
      .refine(noNul, nulMessage)
      .optional()
      .openapi({ description: "Markdown sources only. A URL source's text comes from its page." }),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "nothing to change")
  .openapi("KnowledgeSourceUpdate");

const conflictSchema = z
  .object({
    ...errorSchema.shape,
    /** With `url_taken`: the source that already has this URL, e.g. to re-ingest it. */
    sourceId: z.uuid().optional(),
  })
  .openapi("KnowledgeSourceConflict");
const sourceSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    kind: z.enum(schema.knowledgeSourceKinds),
    title: z.string(),
    url: z.string().nullable(),
    visibility: z.enum(schema.knowledgeVisibilities),
    state: schema.knowledgeSourceStateSchema,
    chunkCount: z.number().int(),
    /** `git` items are changed in the workspace's repo, never through this API. */
    managedBy: z.enum(schema.managedByValues),
    sourcePath: z.string().nullable(),
    /**
     * The embedding model of the current passages. When it isn't the server's model (after a
     * model change), drafts can't use them until the source is re-ingested.
     */
    embeddingModel: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    ingestedAt: z.iso.datetime().nullable(),
  })
  .openapi("KnowledgeSource");

const listRoute = apiRoute({
  operationId: "knowledge.listSources",
  access: { allScopes: ["knowledge:read"] },
  method: "get",
  path: "/v1/knowledge/sources",
  summary: "List knowledge sources",
  description:
    "Every knowledge source in the workspace, oldest first, with its ingestion status. " +
    "Needs `knowledge:read`.",
  responses: {
    200: json(z.object({ sources: z.array(sourceSchema) }), "The sources"),
  },
});

const createSourceRoute = apiRoute({
  operationId: "knowledge.createSource",
  idempotency: "replay",
  access: { allScopes: ["knowledge:write"] },
  audit: { records: ["knowledge_source.created"] },
  method: "post",
  path: "/v1/knowledge/sources",
  summary: "Add a knowledge source",
  description:
    "Adds a web page (`kind: url`) or a markdown document (`kind: markdown`; to upload a " +
    "file, send its text). It is ingested in the background: fetched through an SSRF-safe " +
    "fetch, split into passages and embedded, which counts toward the daily AI budget. The " +
    "status turns `ready` or `failed`. AI drafts then quote matching passages as reference " +
    "data and record which ones they cite. One page per URL source: links are not followed. " +
    "`slug` defaults to one made from the title. `visibility` defaults to `internal`. " +
    "Needs `knowledge:write`.",
  request: {
    body: jsonBody(createBody),
  },
  responses: {
    201: json(sourceSchema, "The new source, status `pending`"),
    409: json(
      conflictSchema,
      "The workspace already has a source with this slug (`slug_taken`), or with this URL " +
        "(`url_taken`, with its `sourceId`). URLs are compared without the fragment, host case " +
        "or a default port.",
    ),
  },
});

const deleteRoute = apiRoute({
  operationId: "knowledge.deleteSource",
  idempotency: "replay",
  access: { allScopes: ["knowledge:write"] },
  audit: { records: ["knowledge_source.deleted"] },
  method: "delete",
  path: "/v1/knowledge/sources/{id}",
  summary: "Delete a knowledge source",
  description:
    "Deletes the source and its passages. Drafts written with it keep their copy of the " +
    "passages they saw, with `sourceId` null. " +
    "Needs `knowledge:write`.",
  request: { params: idParams },
  responses: {
    204: { description: "Deleted" },
    404: notFoundResponse,
    409: json(
      errorSchema,
      "The source is managed in the workspace's git repo (`managed_in_git`): delete the file there",
    ),
  },
});

const reingestRoute = apiRoute({
  operationId: "knowledge.reingestSource",
  idempotency: "replay",
  access: { allScopes: ["knowledge:write"] },
  audit: { records: ["knowledge_source.reingest_requested"] },
  method: "post",
  path: "/v1/knowledge/sources/{id}/reingest",
  summary: "Ingest a knowledge source again",
  description:
    "Sets the source back to `pending` (or preserves a budget wait) and queues it, e.g. after a `failed` ingest, after the " +
    "page changed, or after the embedding model changed. Until the new ingest is done, drafts " +
    "keep using the current passages. If it fails on a temporary problem (the site is down, " +
    "the embedding call failed), they stay. If the page is gone (404, 410) or no longer usable " +
    "(no text, too long, not a page), they're removed. Asking again while it's pending queues " +
    "nothing new, but a request made during a fetch gets a fetch of its own. " +
    "Needs `knowledge:write`.",
  request: { params: idParams },
  responses: {
    202: json(sourceSchema, "The source, pending or waiting for the daily budget"),
    404: notFoundResponse,
    409: json(
      errorSchema,
      "The source is managed in the workspace's git repo (`managed_in_git`): it's re-ingested on sync",
    ),
  },
});

const updateRoute = apiRoute({
  operationId: "knowledge.updateSource",
  idempotency: "replay",
  access: { allScopes: ["knowledge:write"] },
  audit: {
    records: [
      "knowledge_source.edited",
      "knowledge_source.made_public",
      "knowledge_source.made_internal",
    ],
  },
  method: "patch",
  path: "/v1/knowledge/sources/{id}",
  summary: "Edit a knowledge source",
  description:
    "Changes a source's `title`, `visibility` or, for a markdown source, `content`, keeping " +
    "its id and slug so drafts' citations still point at it. A title or visibility change " +
    "applies at once: the next search sees it. A content change removes the old passages " +
    "straight away, so text taken out is never quoted again, and ingests the new text in the " +
    "background (status `pending`, counted toward the daily AI budget). Until that is done the " +
    "source has no passages. Sending what it already has changes nothing and logs nothing. " +
    "Needs `knowledge:write`.",
  request: {
    params: idParams,
    body: jsonBody(updateBody),
  },
  responses: {
    200: json(sourceSchema, "The source as it is now"),
    400: json(errorSchema, "`content` sent for a URL source (`content_not_editable`)"),
    404: notFoundResponse,
    409: json(
      errorSchema,
      "The source is managed in the workspace's git repo (`managed_in_git`): edit the file there",
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
    visibility: s.visibility,
    state: s.state,
    chunkCount: s.chunkCount,
    managedBy: s.managedBy,
    sourcePath: s.sourcePath,
    embeddingModel: s.embeddingModel,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    ingestedAt: s.ingestedAt?.toISOString() ?? null,
  };
}

export function registerKnowledgeRoutes(app: OpenAPIHono, deps: KnowledgeRoutesDeps): void {
  app.openapi(listRoute, async (c) => {
    const principal = c.get("principal");
    const rows = await deps.db.withTenant(principal.tenantId, (tx) =>
      tx
        .select()
        .from(knowledgeSources)
        .orderBy(asc(knowledgeSources.createdAt), asc(knowledgeSources.id)),
    );
    return c.json({ sources: rows.map(serialize) }, 200);
  });

  app.openapi(createSourceRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const input = c.req.valid("json");
    const audit = auditor(c);
    const result = await deps.db.withTenant(tenantId, (tx) =>
      createSource(tx, audit, { tenantId, ...input }),
    );
    if (result.kind === "created") return c.json(serialize(result.source), 201);
    if (result.kind === "url_taken") {
      return errorResponse(
        c,
        { error: result.kind, ...(result.sourceId ? { sourceId: result.sourceId } : {}) },
        409,
      );
    }
    return errorResponse(c, { error: result.kind }, 409);
  });

  app.openapi(reingestRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const { id } = c.req.valid("param");
    const audit = auditor(c);
    const result = await deps.db.withTenant(tenantId, (tx) =>
      requestIngest(tx, audit, { tenantId, id }),
    );
    if (result === "not_found") return notFound(c);
    if (result === "managed_in_git") return errorResponse(c, { error: result }, 409);
    return c.json(serialize(result), 202);
  });

  app.openapi(updateRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const audit = auditor(c);
    const result = await deps.db.withTenant(tenantId, (tx) =>
      updateSource(tx, audit, { tenantId, id, ...input }),
    );
    if (result === "not_found") return notFound(c);
    if (result === "managed_in_git") return errorResponse(c, { error: result }, 409);
    if (result === "content_not_editable") return errorResponse(c, { error: result }, 400);
    return c.json(serialize(result), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { tenantId } = c.get("principal");
    const { id } = c.req.valid("param");
    const audit = auditor(c);
    const result = await deps.db.withTenant(tenantId, (tx) => deleteSource(tx, audit, { id }));
    if (result === "not_found") return notFound(c);
    if (result === "managed_in_git") return errorResponse(c, { error: result }, 409);
    return c.body(null, 204);
  });
}
