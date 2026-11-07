import type { MiddlewareHandler } from "hono";

/**
 * Scopes from #49. `drafts:approve` is separate so an agent can draft without sending.
 * `knowledge:write` is separate from reading, because what's in the knowledge base shapes
 * every draft. `workspace:admin` is for humans only: an agent token can't be granted it.
 */
export const scopes = [
  "tickets:read",
  "drafts:write",
  "drafts:approve",
  "knowledge:read",
  "knowledge:write",
  "workspace:admin",
] as const;
export type Scope = (typeof scopes)[number];

/** Who is calling: one workspace, one actor, an exact list of scopes. */
export interface Principal {
  tenantId: string;
  /** For an agent, the ID of its token: one token is one agent identity. */
  actor: { type: "user" | "agent"; id: string };
  scopes: ReadonlySet<Scope>;
}

/** Turns a request into a principal, or null if it carries no valid credentials. */
export type Authenticate = (request: Request) => Promise<Principal | null>;

/** Nobody is authenticated. Human sessions use this until #46 lands. */
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
  }
}

/**
 * Runs before validation, so an unauthenticated caller learns nothing, not even a 400. Safe to
 * register on overlapping paths: a request is authenticated once.
 */
export function requirePrincipal(authenticate: Authenticate): MiddlewareHandler {
  return async (c, next) => {
    if (c.get("principal")) return next();
    const principal = await authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    return next();
  };
}
