import {
  and,
  asc,
  type Database,
  enqueue,
  eq,
  isKnowledgeUrlTaken,
  isUniqueViolation,
  normalizeKnowledgeUrl,
  schema,
  sql,
  uuidv7,
} from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { type AuditAction, nothingToAudit } from "../audit/audit.ts";
import { apiRoute } from "../auth/access.ts";
import {
  auditor,
  errorSchema,
  idParams,
  json,
  jsonBody,
  notFound,
  notFoundResponse,
} from "../http/route-kit.ts";
import { ingestSourceJob } from "./jobs.ts";

const { knowledgeChunks, knowledgeSources } = schema;
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
    error: z.string(),
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

/** A slug from a title: "Refunds & Returns!" becomes "refunds-returns". */
export function slugify(title: string): string {
  return (
    title
      .normalize("NFKD")
      // NFKD splits "é" into "e" plus an accent mark; dropping the marks keeps the word whole.
      .replaceAll(/\p{M}/gu, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "")
  );
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
    const principal = c.get("principal");
    const input = c.req.valid("json");
    const { tenantId } = principal;
    const audit = auditor(c);
    const id = uuidv7();
    const url = input.kind === "url" ? normalizeKnowledgeUrl(input.url) : null;
    const base = slugify(input.title);
    // A slug the caller chose is kept or refused. One made from the title gets a random
    // suffix when another source already has it (two pages can share a title), a new one on
    // each try, and a title with no Latin letters or digits gets only that. A failed try rolled
    // back, so the next one can reuse the id.
    const suffix = () => uuidv7().slice(-12);
    const slugs = input.slug
      ? [input.slug]
      : [
          ...(base ? [base] : []),
          ...Array.from({ length: 3 }, () => `${base || "source"}-${suffix()}`),
        ];

    try {
      for (const slug of slugs) {
        const created = await insertSource(slug);
        if (created) return c.json(serialize(created), 201);
      }
    } catch (error) {
      if (!url || !isKnowledgeUrlTaken(error)) throw error;
      const sourceId = await sourceWithUrl(url);
      // Deleted between the failed insert and this read: rare, and a retry would succeed.
      return c.json({ error: "url_taken", ...(sourceId ? { sourceId } : {}) }, 409);
    }
    // Postgres may report the slug before the URL, so a repeat with the same slug lands here.
    const sourceId = url ? await sourceWithUrl(url) : undefined;
    if (sourceId) return c.json({ error: "url_taken", sourceId }, 409);
    return c.json({ error: "slug_taken" }, 409);

    /** Read in this workspace only, so it can only ever name the caller's own source. */
    async function sourceWithUrl(url: string): Promise<string | undefined> {
      const [existing] = await deps.db.withTenant(tenantId, (tx) =>
        tx
          .select({ id: knowledgeSources.id })
          .from(knowledgeSources)
          .where(and(eq(knowledgeSources.kind, "url"), eq(knowledgeSources.url, url))),
      );
      return existing?.id;
    }

    /** The new source, or undefined when the workspace already uses the slug. */
    async function insertSource(slug: string): Promise<SourceRow | undefined> {
      try {
        return await deps.db.withTenant(tenantId, async (tx) => {
          const [row] = await tx
            .insert(knowledgeSources)
            .values({
              id,
              tenantId,
              slug,
              kind: input.kind,
              title: input.title,
              url,
              content: input.kind === "markdown" ? input.content : null,
              ...(input.visibility ? { visibility: input.visibility } : {}),
            })
            .returning();
          if (!row) throw new Error("create knowledge source: insert returned no row");
          await audit(tx, "knowledge_source.created", { type: "knowledge_source", id });
          // In the same transaction: the source and its ingest job exist together or not at all.
          await enqueue(
            tx,
            ingestSourceJob,
            { tenantId, sourceId: id, requests: row.ingestRequests },
            { singletonKey: id },
          );
          return row;
        });
      } catch (error) {
        // Per workspace: this says nothing about other workspaces' slugs.
        if (isUniqueViolation(error, "knowledge_sources_tenant_slug")) return undefined;
        throw error;
      }
    }
  });

  app.openapi(reingestRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const { tenantId } = principal;
    const audit = auditor(c);
    const result = await deps.db.withTenant(tenantId, async (tx) => {
      const [found] = await tx
        .select({
          managedBy: knowledgeSources.managedBy,
          state: knowledgeSources.state,
        })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, id))
        .for("update");
      if (!found) return "not_found" as const;
      if (found.managedBy === "git") return "managed_in_git" as const;
      const [row] = await tx
        .update(knowledgeSources)
        .set({
          state:
            found.state.status === "waiting" && found.state.reason.code === "daily_budget_reached"
              ? found.state
              : { status: "pending" },
          retryCount: 0,
          ingestRequests: sql`${knowledgeSources.ingestRequests} + 1`,
        })
        .where(eq(knowledgeSources.id, id))
        .returning();
      if (!row) throw new Error("reingest: update returned no row");
      await audit(tx, "knowledge_source.reingest_requested", { type: "knowledge_source", id });
      // Already pending: reuse its job rather than queue two. If that job is already fetching,
      // it sees this request when it writes (the count went up) and queues a run for it.
      // Otherwise always queue a new one. The last job may have committed but still look
      // unfinished to pg-boss, and reusing it would leave this source pending with no job.
      await enqueue(
        tx,
        ingestSourceJob,
        { tenantId, sourceId: id, requests: row.ingestRequests },
        found.state.status === "pending" || found.state.status === "waiting"
          ? { singletonKey: id }
          : {},
      );
      return row;
    });
    if (result === "not_found") return notFound(c);
    if (result === "managed_in_git") return c.json({ error: "managed_in_git" }, 409);
    return c.json(serialize(result), 202);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const { tenantId } = principal;
    const audit = auditor(c);
    const result = await deps.db.withTenant(tenantId, async (tx) => {
      const [found] = await tx
        .select()
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, id))
        .for("update");
      // Another workspace's source looks exactly like one that doesn't exist.
      if (!found) return "not_found" as const;
      if (found.managedBy === "git") return "managed_in_git" as const;
      if (input.content !== undefined && found.kind !== "markdown") {
        return "content_not_editable" as const;
      }
      const title = input.title !== undefined && input.title !== found.title;
      const visibility = input.visibility !== undefined && input.visibility !== found.visibility;
      const content = input.content !== undefined && input.content !== found.content;
      if (!title && !visibility && !content) {
        nothingToAudit("same title, visibility and content");
        return found;
      }

      const [row] = await tx
        .update(knowledgeSources)
        .set({
          ...(title ? { title: input.title } : {}),
          ...(visibility ? { visibility: input.visibility } : {}),
          ...(content
            ? {
                content: input.content,
                state: { status: "pending" as const },
                retryCount: 0,
                chunkCount: 0,
                embeddingModel: null,
                // An ingest already fetching the old text sees this and doesn't write it.
                ingestRequests: sql`${knowledgeSources.ingestRequests} + 1`,
              }
            : {}),
        })
        .where(eq(knowledgeSources.id, id))
        .returning();
      if (!row) throw new Error("update knowledge source: update returned no row");
      if (content) {
        // The old passages go now, not when the new ones are ready: an edit often removes
        // something wrong or private, and that must stop being quoted at once.
        await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, id));
        await enqueue(tx, ingestSourceJob, {
          tenantId,
          sourceId: id,
          requests: row.ingestRequests,
        });
      }
      const record = (action: AuditAction) => audit(tx, action, { type: "knowledge_source", id });
      if (title || content) await record("knowledge_source.edited");
      // There are two visibilities, so the new one names the old one too: what customers may
      // be shown is always traceable.
      if (visibility) {
        await record(
          row.visibility === "public"
            ? "knowledge_source.made_public"
            : "knowledge_source.made_internal",
        );
      }
      return row;
    });
    if (result === "not_found") return notFound(c);
    if (result === "managed_in_git") return c.json({ error: "managed_in_git" }, 409);
    if (result === "content_not_editable") return c.json({ error: "content_not_editable" }, 400);
    return c.json(serialize(result), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = c.get("principal");
    const audit = auditor(c);
    const { id } = c.req.valid("param");
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [found] = await tx
        .select({ managedBy: knowledgeSources.managedBy })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, id))
        .for("update");
      // Another workspace's source looks exactly like one that doesn't exist.
      if (!found) return "not_found" as const;
      // Git owns these rows; the API never writes them.
      if (found.managedBy === "git") return "managed_in_git" as const;
      // Its chunks go with it (ON DELETE CASCADE); drafts' copies of its passages stay.
      await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
      await audit(tx, "knowledge_source.deleted", { type: "knowledge_source", id });
      return "deleted" as const;
    });
    if (result === "not_found") return notFound(c);
    if (result === "managed_in_git") return c.json({ error: "managed_in_git" }, 409);
    return c.body(null, 204);
  });
}
