import { schema } from "@helpos/db";
import type { Actor } from "@helpos/db/actor";
import type { MiddlewareHandler } from "hono";

/**
 * Every scope the API checks: what an agent token may hold (`apiTokenScopes`, the one list in
 * the database schema, which also builds the table's CHECK) plus `workspace:admin`, which is for
 * humans only: an agent token can't be granted it. A new scope is one line in `apiTokenScopes`
 * (and a generated migration); it never needs a second edit here.
 */
export const scopes = [...schema.apiTokenScopes, "workspace:admin"] as const;
export type Scope = (typeof scopes)[number];

/** Who is calling: one workspace, one actor, an exact list of scopes. */
export interface Principal {
  tenantId: string;
  /** For an agent, the ID of its token: one token is one agent identity. */
  actor: Extract<Actor, { type: "user" | "agent" }>;
  scopes: ReadonlySet<Scope>;
}

/** Turns a request into a principal, or null if it carries no valid credentials. */
export type Authenticate = (request: Request) => Promise<Principal | null>;

/** Nobody is authenticated. Used for human sessions when no HELPOS_AUTH_SECRET is set. */
export const refuseAll: Authenticate = async () => null;

/**
 * Agent tokens and human sessions in one. A request with an `Authorization` header is judged
 * on that header alone: a bad token sent next to a valid session cookie is refused, never
 * quietly let through on the cookie.
 */
export function authenticateRequest(parts: {
  tokens: Authenticate;
  session: Authenticate;
}): Authenticate {
  return (request) =>
    request.headers.has("authorization") ? parts.tokens(request) : parts.session(request);
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
    /** How this app resolves callers. Set for every request by `callerResolver()`. */
    authenticate: Authenticate;
  }
}

/**
 * Tells the routes how to resolve a caller. Register it once, on the whole app: `apiRoute()`
 * then authenticates the request itself, before validation, so an unauthenticated caller
 * learns nothing, not even a 400. A route needs no path middleware of its own.
 */
export function callerResolver(authenticate: Authenticate): MiddlewareHandler {
  return (c, next) => {
    c.set("authenticate", authenticate);
    return next();
  };
}
