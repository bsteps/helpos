import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { type AuditContext, type Auditor, auditorFor } from "../audit/audit.ts";

// What every route file needs, in one place. A route file never defines its own copy: the
// route-*.grit Biome plugins fail when one does (scripts/biome-plugins.test.mjs proves they fire).

/** The one error body of the API. Registered once, as the `Error` component. */
export const errorSchema = z.object({ error: z.string() }).openapi("Error");

/** An OpenAPI response with a JSON body. */
export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

/** A required JSON request body. */
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { "application/json": { schema } },
});

/** The `{id}` path parameter every item route takes. */
export const idParams = z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) });

/**
 * The 404 of a route that looks something up. Another workspace's row looks exactly like one
 * that doesn't exist, so there is only one answer.
 */
export const notFoundResponse = json(errorSchema, "Not found in this workspace");

/** Answers a missing (or other workspace's) row. Pair it with `404: notFoundResponse`. */
export function notFound(c: Context) {
  return c.json({ error: "not_found" }, 404);
}

export type { Auditor };

export function auditContext(c: Context): AuditContext {
  const { tenantId, actor } = c.get("principal");
  const requestId = c.get("requestId");
  return { tenantId, actor, requestId };
}

/**
 * Audit recording bound to the request: the caller's workspace and identity and the request ID
 * come from the request itself, so a handler can't record them wrong, or for someone else.
 * Call it with the transaction that makes the change, so both commit together.
 */
export function auditor(c: Context): Auditor {
  const { tenantId, actor, requestId } = auditContext(c);
  return auditorFor(tenantId, actor, requestId);
}
