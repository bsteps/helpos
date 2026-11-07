import type { Database } from "@helpos/db";
import type { Authenticate } from "../auth/principal.ts";
import { bearerToken, hashesMatch, hashToken } from "./token.ts";

/**
 * Resolves `Authorization: Bearer hos_…` to the token's workspace, agent identity and scopes.
 * Unknown, malformed and revoked tokens all get the same answer (null, so 401): the caller
 * can't tell which it was.
 */
export function agentTokens(db: Pick<Database, "resolveApiToken">): Authenticate {
  return async (request) => {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) return null;
    const hash = hashToken(token);
    const found = await db.resolveApiToken(hash);
    if (!found || !hashesMatch(hash, found.tokenHash) || found.revokedAt) return null;
    return {
      tenantId: found.tenantId,
      actor: { type: "agent", id: found.id },
      scopes: new Set(found.scopes),
    };
  };
}
