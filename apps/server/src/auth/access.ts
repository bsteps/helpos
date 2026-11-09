import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { type AuditAction, auditTrail } from "../audit/audit.ts";
import type { Principal, Scope } from "./principal.ts";

/**
 * Who may call a route. Every route says it in its definition, so a new route can't forget the
 * check, and the check runs before the body is read: a caller without the scope learns nothing,
 * not even a 400.
 *
 * - `allScopes`: the caller holds every scope listed.
 * - `anyScope`: the caller holds at least one.
 * - `humansOnly`: an agent token is refused (`session_required`) even with the scopes.
 * - `anyCaller`: any authenticated caller, whatever its scopes. Say why.
 * - `noCaller`: no principal at all, because the route proves the caller another way (a
 *   provider secret, a webhook signature, a password). Say how.
 */
export type Access =
  | { readonly allScopes: readonly [Scope, ...Scope[]]; readonly humansOnly?: true }
  | { readonly anyScope: readonly [Scope, Scope, ...Scope[]]; readonly humansOnly?: true }
  | { readonly anyCaller: string }
  | { readonly noCaller: string };

/**
 * What a write route records in the audit log. Required on every POST, PUT, PATCH and DELETE.
 *
 * - `records`: every audit action the route may record. A success that records none of them
 *   fails (500), unless the handler calls `nothingToAudit()`; recording one not listed fails too.
 * - `none`: the route has nothing to audit. Say why.
 */
export type Audit =
  | { readonly records: readonly [AuditAction, ...AuditAction[]] }
  | { readonly none: string };

type WriteMethod = "post" | "put" | "patch" | "delete";

/**
 * Proof that a caller holds `scope`. Only `Grant.check()` makes one, so a function that takes a
 * Grant can't be reached without checking. Use it for data that a route shows only to some of
 * its callers (a draft's knowledge sources need `knowledge:read`).
 */
export class Grant<S extends Scope> {
  // A true private field makes the type nominal: an object literal can't pass for a Grant.
  readonly #scope: S;

  private constructor(scope: S) {
    this.#scope = scope;
  }

  get scope(): S {
    return this.#scope;
  }

  static check<S extends Scope>(principal: Principal, scope: S): Grant<S> | null {
    return principal.scopes.has(scope) ? new Grant(scope) : null;
  }
}

/** Why `principal` may not call a route with `access`, or null when it may. */
function accessRefusal(
  access: Access,
  principal: Principal | undefined,
): "unauthorized" | "forbidden" | "session_required" | null {
  if ("noCaller" in access) return null;
  if (!principal) return "unauthorized";
  if ("anyCaller" in access) return null;
  if (access.humansOnly && principal.actor.type !== "user") return "session_required";
  const held = (s: Scope) => principal.scopes.has(s);
  const ok = "allScopes" in access ? access.allScopes.every(held) : access.anyScope.some(held);
  return ok ? null : "forbidden";
}

function enforce(name: string, access: Access, audit: Audit | undefined): MiddlewareHandler {
  return async (c, next) => {
    // `principal` is set by requirePrincipal() on the feature's paths. A route registered
    // without it is refused, not let through.
    const refusal = accessRefusal(access, c.get("principal"));
    if (refusal === "unauthorized") return c.json({ error: refusal }, 401);
    if (refusal) return c.json({ error: refusal }, 403);
    if (!audit || "none" in audit) return next();

    const trail = { recorded: new Set<AuditAction>(), nothingChanged: false };
    await auditTrail.run(trail, next);
    const declared: readonly AuditAction[] = audit.records;
    const undeclared = [...trail.recorded].filter((a) => !declared.includes(a));
    if (undeclared.length > 0) {
      throw new Error(
        `${name} recorded ${undeclared.join(", ")}: add it to the route's audit.records`,
      );
    }
    // Only a success: a refused or failed request has rolled back, audit event and all.
    const ok = c.res.status >= 200 && c.res.status < 300;
    if (ok && trail.recorded.size === 0 && !trail.nothingChanged) {
      throw new Error(
        `${name} succeeded without an audit event: call recordAudit() in the handler's ` +
          `transaction, or nothingToAudit() when the request changed nothing`,
      );
    }
  };
}

/**
 * The only way to define an API route: `createRoute()` plus a required `access`, and on a
 * write route a required `audit`. Both are enforced by middleware: access before validation
 * and the handler, audit after the handler. Both are published in the OpenAPI document
 * (`x-access`, `x-audit`), so agents can read what each operation needs and records.
 */
export function apiRoute<const R extends Omit<RouteConfig, "middleware">>(
  config: R & { access: Access } & (R["method"] extends WriteMethod
      ? { audit: Audit }
      : { audit?: never }),
) {
  const { access, audit, ...rest } = config;
  // TypeScript can't see that removing `access` and `audit` from R leaves R's own route fields.
  const route = rest as unknown as R;
  const name = `${route.method.toUpperCase()} ${route.path}`;
  return createRoute({
    ...route,
    "x-access": access,
    ...(audit ? { "x-audit": audit } : {}),
    middleware: [enforce(name, access, audit)] as const,
  });
}
