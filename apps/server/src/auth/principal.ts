import type { MiddlewareHandler } from "hono";

/** Scopes from #49. `drafts:approve` is separate so an agent can draft without sending. */
export const scopes = ["tickets:read", "drafts:write", "drafts:approve"] as const;
export type Scope = (typeof scopes)[number];

/** Who is calling: one workspace, one actor, an exact list of scopes. */
export interface Principal {
  tenantId: string;
  actor: { type: "user" | "agent"; id: string };
  scopes: ReadonlySet<Scope>;
}

/**
 * Turns a request into a principal, or null if it carries no valid credentials. Agent tokens
 * (#49) and human sessions (#46) each plug in here; nothing else in the API knows how.
 */
export type Authenticate = (request: Request) => Promise<Principal | null>;

/**
 * The default until #49 and #46 land: nobody is authenticated, so every protected route
 * answers 401. Secure by default, like the inbound endpoint without a secret.
 */
export const refuseAll: Authenticate = async () => null;

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
  }
}

/** Runs before validation, so an unauthenticated caller learns nothing, not even a 400. */
export function requirePrincipal(authenticate: Authenticate): MiddlewareHandler {
  return async (c, next) => {
    const principal = await authenticate(c.req.raw);
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    return next();
  };
}
