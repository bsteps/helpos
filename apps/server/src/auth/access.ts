import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
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

function enforce(access: Access): MiddlewareHandler {
  return async (c, next) => {
    // `principal` is set by requirePrincipal() on the feature's paths. A route registered
    // without it is refused, not let through.
    const refusal = accessRefusal(access, c.get("principal"));
    if (refusal === "unauthorized") return c.json({ error: refusal }, 401);
    if (refusal) return c.json({ error: refusal }, 403);
    return next();
  };
}

/**
 * The only way to define an API route: `createRoute()` plus a required `access`. The access is
 * enforced by middleware that runs before validation and the handler, and is published in the
 * OpenAPI document as `x-access`, so agents can read what each operation needs.
 */
export function apiRoute<const R extends Omit<RouteConfig, "middleware">>(
  config: R & { access: Access },
) {
  const { access, ...rest } = config;
  // TypeScript can't see that removing `access` from R leaves R's own route fields.
  const route = rest as unknown as R;
  return createRoute({ ...route, "x-access": access, middleware: [enforce(access)] as const });
}
