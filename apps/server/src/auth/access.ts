import { isHuman } from "@helpos/db/actor";
import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { type AuditAction, auditTrail } from "../audit/audit.ts";
import { keyedWrite } from "../http/idempotency.ts";
import { errorResponse, errorSchema, json } from "../http/route-kit.ts";
import type { Authenticate, Principal, Scope } from "./principal.ts";

/**
 * Who may call a route. Every route says it in its definition, so a new route can't forget the
 * check, and the check runs before the body is read: a caller without the scope learns nothing,
 * not even a 400.
 *
 * - `allScopes`: the caller holds every scope listed.
 * - `anyScope`: the caller holds at least one.
 * - `humansOnly`: an agent token is refused (`session_required`) even with the scopes.
 * - `selfOrAdmin`: an agent may revoke its own token; a human admin may revoke any token.
 * - `anyCaller`: any authenticated caller, whatever its scopes. Say why.
 * - `noCaller`: no principal at all, because the route proves the caller another way (a
 *   provider secret, a webhook signature, a password). Say how.
 */
export type Access =
  | { readonly allScopes: readonly [Scope, ...Scope[]]; readonly humansOnly?: true }
  | { readonly anyScope: readonly [Scope, Scope, ...Scope[]]; readonly humansOnly?: true }
  | { readonly selfOrAdmin: { readonly tokenIdParam: "id" } }
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

/**
 * What a write route does with an `Idempotency-Key`. Required on every POST, PUT, PATCH and
 * DELETE, so no write stores its response for replay without saying so.
 *
 * - `"replay"`: the response is stored and replayed to a retry with the same key
 *   (docs/api-conventions.md).
 * - `refuse`: a keyed request gets `400 idempotency_not_supported` before the handler runs. Say
 *   why. A route whose response carries a credential refuses, so the credential is never stored.
 *   A `noCaller` route always refuses: there is no caller to scope the key to.
 */
export type Idempotency = "replay" | { readonly refuse: string };

const writeMethods = ["post", "put", "patch", "delete"] as const;
type WriteMethod = (typeof writeMethods)[number];

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
  tokenId: string | undefined,
): "unauthorized" | "forbidden" | "session_required" | null {
  if ("noCaller" in access) return null;
  if (!principal) return "unauthorized";
  if ("anyCaller" in access) return null;
  if ("selfOrAdmin" in access) {
    const self = principal.actor.type === "agent" && principal.actor.id === tokenId;
    const admin = isHuman(principal.actor) && principal.scopes.has("workspace:admin");
    return self || admin ? null : "forbidden";
  }
  if (access.humansOnly && !isHuman(principal.actor)) return "session_required";
  const held = (s: Scope) => principal.scopes.has(s);
  const ok = "allScopes" in access ? access.allScopes.every(held) : access.anyScope.some(held);
  return ok ? null : "forbidden";
}

/** The caller, authenticated once per request (a route that is matched twice reuses it). */
async function resolveCaller(c: Context): Promise<Principal | undefined> {
  const known: Principal | undefined = c.get("principal");
  if (known) return known;
  const authenticate: Authenticate | undefined = c.get("authenticate");
  // An app without callerResolver() refuses every caller, instead of letting one through.
  const principal = authenticate ? await authenticate(c.req.raw) : null;
  if (!principal) return undefined;
  c.set("principal", principal);
  return principal;
}

function enforce(
  name: string,
  access: Access,
  audit: Audit | undefined,
  idempotency: Idempotency | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const principal = "noCaller" in access ? undefined : await resolveCaller(c);
    const tokenId =
      "selfOrAdmin" in access ? c.req.param(access.selfOrAdmin.tokenIdParam) : undefined;
    const refusal = accessRefusal(access, principal, tokenId);
    if (refusal === "unauthorized") return errorResponse(c, { error: refusal }, 401);
    if (refusal) return errorResponse(c, { error: refusal }, 403);
    const run = () => enforceAudit(name, audit, c, next);
    if (idempotency === "replay") return keyedWrite(c, run);
    if (idempotency && c.req.header("Idempotency-Key") !== undefined) {
      return errorResponse(c, { error: "idempotency_not_supported" }, 400);
    }
    return run();
  };
}

async function enforceAudit(
  name: string,
  audit: Audit | undefined,
  c: Context,
  next: () => Promise<void>,
) {
  if (!audit || "none" in audit) return next();

  const trail = { recorded: new Set<AuditAction>(), nothingChanged: false };
  await auditTrail.run(trail, next);
  if (c.res.status >= 500) return;
  const declared: readonly AuditAction[] = audit.records;
  const undeclared = [...trail.recorded].filter((a) => !declared.includes(a));
  if (undeclared.length > 0) {
    throw new Error(
      `${name} recorded ${undeclared.join(", ")}: add it to the route's audit.records`,
    );
  }
  const ok = c.res.status >= 200 && c.res.status < 300;
  if (ok && trail.recorded.size === 0 && !trail.nothingChanged) {
    throw new Error(
      `${name} succeeded without an audit event: call recordAudit() in the handler's ` +
        `transaction, or nothingToAudit() when the request changed nothing`,
    );
  }
}

const unauthorizedResponse = json(errorSchema, "No valid credentials");
const forbiddenResponse = json(errorSchema, "The credentials lack the required scope");
const writeErrorResponses = {
  400: json(
    errorSchema,
    "Invalid request or idempotency key; credential and provider writes refuse keyed requests",
  ),
  409: json(errorSchema, "The idempotency key conflicts, is pending, or has expired"),
  503: json(errorSchema, "Idempotency storage or a required service is unavailable"),
};

/**
 * The 401 and 403 an access rule can produce, documented on the route without it saying so.
 * A route that needs something more specific says it in its own `responses`.
 */
type AuthResponses<A extends Access> = A extends { noCaller: string }
  ? Record<never, never>
  : A extends { anyCaller: string }
    ? { 401: typeof unauthorizedResponse }
    : { 401: typeof unauthorizedResponse; 403: typeof forbiddenResponse };

function authResponses<A extends Access>(access: A): AuthResponses<A> {
  const responses =
    "noCaller" in access
      ? {}
      : "anyCaller" in access
        ? { 401: unauthorizedResponse }
        : { 401: unauthorizedResponse, 403: forbiddenResponse };
  return responses as AuthResponses<A>;
}

/**
 * The only way to define an API route: `createRoute()` plus a required `access`, and on a
 * write route a required `audit` and `idempotency`. All are enforced by middleware: access
 * before validation and the handler, audit after the handler. All are published in the OpenAPI
 * document (`x-access`, `x-audit`, `x-idempotency`), so agents can read what each operation
 * needs, records and replays.
 *
 * The caller is authenticated here too, so a route needs no path middleware, and it gets
 * what follows from its `access`: the `apiAuth` security scheme and the 401 and 403 responses.
 * A `noCaller` route proves its caller another way and states that in its own `security`.
 */
export function apiRoute<
  const R extends Omit<RouteConfig, "middleware"> & { operationId: string },
  const A extends Access,
>(
  config: R & {
    access: A;
    operationId: R["operationId"] extends "" ? never : string;
  } & (R["method"] extends WriteMethod
      ? {
          audit: Audit;
          idempotency: A extends { noCaller: string } ? { readonly refuse: string } : Idempotency;
        }
      : { audit?: never; idempotency?: never }),
) {
  if (!config.operationId.trim()) throw new Error("apiRoute requires a nonempty operationId");
  const { access, audit, idempotency, ...rest } = config;
  // TypeScript can't see that removing these fields from R leaves R's own route fields.
  const route = rest as unknown as R;
  const name = `${route.method.toUpperCase()} ${route.path}`;
  const write = writeMethods.some((method) => method === route.method);
  const responses = {
    ...authResponses<A>(access),
    ...(write ? writeErrorResponses : {}),
    ...route.responses,
  };
  return createRoute({
    ...route,
    ...(idempotency === "replay"
      ? {
          parameters: [
            {
              in: "header" as const,
              name: "Idempotency-Key",
              required: false,
              schema: { type: "string" as const, minLength: 1, maxLength: 200 },
              description:
                "Optional write key, isolated by tenant and caller. Reuse requires the same method, URL, content type, body bytes and scopes. Successful responses replay for 24 hours. Pending and expired keys never execute again. See docs/api-conventions.md.",
            },
          ],
        }
      : {}),
    ...("noCaller" in access || route.security ? {} : { security: [{ apiAuth: [] }] }),
    responses,
    "x-access": access,
    ...(audit ? { "x-audit": audit } : {}),
    ...(idempotency ? { "x-idempotency": idempotency } : {}),
    middleware: [enforce(name, access, audit, idempotency)] as const,
  });
}
