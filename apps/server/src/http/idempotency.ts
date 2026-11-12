import { createHash } from "node:crypto";
import { and, eq, schema } from "@helpos/db";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Services } from "../services.ts";
import { errorResponse } from "./route-kit.ts";

const keySchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const lifetimeMs = 24 * 60 * 60 * 1_000;
const table = schema.httpIdempotency;

declare module "hono" {
  interface ContextVariableMap {
    idempotency: MiddlewareHandler;
  }
}

const credentialWrites = new Set([
  "POST /v1/tokens",
  "PUT /v1/integrations/github",
  "POST /v1/integrations/github/webhook-secret",
]);

export function idempotency(deps: Pick<Services, "db" | "clock">): MiddlewareHandler {
  return async (c, next) => {
    const rawKey = c.req.header("Idempotency-Key");
    if (rawKey === undefined) return next();
    const key = keySchema.safeParse(rawKey);
    if (!key.success) return errorResponse(c, { error: "invalid_idempotency_key" }, 400);
    const principal = c.get("principal");
    if (!principal || credentialWrites.has(`${c.req.method} ${c.req.routePath}`)) {
      return errorResponse(c, { error: "idempotency_not_supported" }, 400);
    }
    const url = new URL(c.req.url);
    const fingerprint = hash(
      JSON.stringify([
        c.req.method,
        url.pathname + url.search,
        c.req.header("content-type") ?? "",
        [...principal.scopes].sort(),
        hash(new Uint8Array(await c.req.raw.clone().arrayBuffer())),
      ]),
    );
    const identity = and(
      eq(table.actorType, principal.actor.type),
      eq(table.actorId, principal.actor.id),
      eq(table.keyHash, hash(key.data)),
    );
    const now = deps.clock.now();
    const claim = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [inserted] = await tx
        .insert(table)
        .values({
          tenantId: principal.tenantId,
          actorType: principal.actor.type,
          actorId: principal.actor.id,
          keyHash: hash(key.data),
          fingerprint,
          expiresAt: new Date(now.getTime() + lifetimeMs),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return { kind: "claimed", row: inserted } as const;
      const [existing] = await tx.select().from(table).where(identity);
      if (!existing) throw new Error("idempotency reservation disappeared");
      return { kind: "existing", row: existing } as const;
    });
    if (claim.kind === "existing") {
      const row = claim.row;
      if (row.fingerprint !== fingerprint)
        return errorResponse(c, { error: "idempotency_conflict" }, 409);
      if (row.expiresAt <= now) {
        await deps.db.withTenant(principal.tenantId, (tx) =>
          tx.update(table).set({ responseBody: null }).where(identity),
        );
        return errorResponse(c, { error: "idempotency_expired" }, 409);
      }
      if (row.responseStatus === null || row.responseBody === null) {
        return errorResponse(c, { error: "idempotency_pending" }, 409);
      }
      return new Response(row.responseStatus === 204 ? null : row.responseBody, {
        status: row.responseStatus,
        headers: { "Content-Type": "application/json", "Idempotency-Replayed": "true" },
      });
    }
    await next();
    const replayableStatus =
      (c.res.status >= 200 && c.res.status < 300) || (c.res.status >= 400 && c.res.status < 500);
    const replayableBody =
      c.res.status === 204 || c.res.headers.get("content-type")?.startsWith("application/json");
    const canReplay =
      !c.error && replayableStatus && replayableBody && !c.res.headers.has("set-cookie");
    if (!canReplay) return;
    const responseBody = await c.res.clone().text();
    await deps.db.withTenant(principal.tenantId, (tx) =>
      tx.update(table).set({ responseStatus: c.res.status, responseBody }).where(identity),
    );
  };
}

export function keyedWrite(c: Context, next: () => Promise<void>) {
  const middleware: MiddlewareHandler | undefined = c.get("idempotency");
  if (middleware) return middleware(c, next);
  if (c.req.header("Idempotency-Key") !== undefined) {
    return errorResponse(c, { error: "idempotency_unavailable" }, 503);
  }
  return next();
}
