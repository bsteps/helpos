import type { Database, SessionAuth, schema } from "@helpos/db";
import { type Authenticate, type Scope, scopes } from "./principal.ts";

/** What a signed-in human may do. Only owners administer the workspace. */
function scopesForRole(role: schema.WorkspaceRole): ReadonlySet<Scope> {
  return new Set(role === "owner" ? scopes : scopes.filter((s) => s !== "workspace:admin"));
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A browser always sends `Origin` on a cross-site POST, PATCH or DELETE. A request whose Origin
 * is not the dashboard's is someone else's page acting with our cookie (CSRF), so it is refused
 * even though SameSite=Lax cookies should already keep it out. Clients that aren't browsers
 * send no Origin and have no victim's cookie to ride on.
 */
export function fromForeignOrigin(request: Request, trustedOrigin: string): boolean {
  if (safeMethods.has(request.method)) return false;
  const origin = request.headers.get("origin");
  return origin !== null && origin !== trustedOrigin;
}

/**
 * Human sessions: the session cookie resolves to a user, and the user's first workspace
 * (oldest membership) to the tenant. A workspace switcher comes later. No membership: nobody.
 */
export function humanSessions(deps: {
  sessions: Pick<SessionAuth, "resolveSession">;
  db: Pick<Database, "listMemberships">;
  trustedOrigin: string;
}): Authenticate {
  return async (request) => {
    if (fromForeignOrigin(request, deps.trustedOrigin)) return null;
    const user = await deps.sessions.resolveSession(request.headers);
    if (!user) return null;
    const [membership] = await deps.db.listMemberships(user.userId);
    if (!membership) return null;
    return {
      tenantId: membership.tenantId,
      actor: { type: "user", id: user.userId },
      scopes: scopesForRole(membership.role),
    };
  };
}
