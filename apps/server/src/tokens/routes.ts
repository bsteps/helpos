import { and, asc, type Database, eq, isNull, schema } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { nothingToAudit, recordAudit } from "../audit/audit.ts";
import { apiRoute } from "../auth/access.ts";
import { type Authenticate, type Principal, requirePrincipal } from "../auth/principal.ts";
import { type ApiTokenRow, createApiToken } from "./create-token.ts";
import { tokenScopes } from "./token.ts";

const { apiTokens } = schema;

export interface TokenRoutesDeps {
  db: Pick<Database, "withTenant">;
  authenticate: Authenticate;
}

const errorSchema = z.object({ error: z.string() }).openapi("Error");
const scopeSchema = z.enum(schema.apiTokenScopes).openapi("TokenScope");
const tokenSchema = z
  .object({
    id: z.uuid(),
    /** The agent's name. Audit events name the agent by this token's ID. */
    name: z.string(),
    scopes: z.array(scopeSchema),
    createdAt: z.iso.datetime(),
    /** Set once revoked. A revoked token is refused with 401 and can't be used again. */
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("ApiToken");
const createdTokenSchema = tokenSchema
  .extend({
    /** The token itself, `hos_…`. Shown only in this response: only its hash is stored. */
    token: z.string(),
  })
  .openapi("CreatedApiToken");
type TokenJson = z.infer<typeof tokenSchema>;

const json = <T extends z.ZodType>(s: T, description: string) => ({
  description,
  content: { "application/json": { schema: s } },
});
const security = [{ apiAuth: [] }];
const adminErrors = {
  401: json(errorSchema, "No valid credentials"),
  403: json(
    errorSchema,
    "Called with an agent token (`session_required`), or without `workspace:admin`",
  ),
} as const;

const createTokenRoute = apiRoute({
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  audit: { records: ["api_token.created"] },
  method: "post",
  path: "/v1/tokens",
  summary: "Create an agent token",
  description:
    "Creates a token for one agent, with exactly the scopes given. The response holds the " +
    "token itself, the only time it is shown: store it right away. Needs a human session with " +
    "`workspace:admin`; an agent token can't create tokens. A token can only get scopes its " +
    "creator holds (`scope_not_held`).",
  security,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            name: z.string().trim().min(1).max(100),
            scopes: z.array(scopeSchema).min(1).max(tokenScopes.length),
          }),
        },
      },
    },
  },
  responses: { 201: json(createdTokenSchema, "The new token"), ...adminErrors },
});

const listTokensRoute = apiRoute({
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  method: "get",
  path: "/v1/tokens",
  summary: "List the workspace's agent tokens",
  description:
    "Every agent token, revoked ones too, oldest first. Never includes the tokens themselves. " +
    "Needs a human session with `workspace:admin`.",
  security,
  responses: {
    200: json(z.object({ tokens: z.array(tokenSchema) }), "The tokens"),
    ...adminErrors,
  },
});

const revokeTokenRoute = apiRoute({
  access: {
    anyCaller:
      "an agent may revoke its own token; anyone else needs workspace:admin in a human session, checked in the handler",
  },
  audit: { records: ["api_token.revoked"] },
  method: "delete",
  path: "/v1/tokens/{id}",
  summary: "Revoke an agent token",
  description:
    "Revokes a token at once: every later request with it gets 401. The token stays listed, " +
    "so audit events still name it. Revoking a revoked token changes nothing. Needs a human " +
    "session with `workspace:admin`, or the token itself: an agent can always revoke its own " +
    "token, e.g. when it may have leaked.",
  security,
  request: { params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }) },
  responses: {
    204: { description: "Revoked" },
    401: adminErrors[401],
    403: json(errorSchema, "Neither `workspace:admin` in a human session nor the token itself"),
    404: json(errorSchema, "Not found in this workspace"),
  },
});

function serialize(t: ApiTokenRow): TokenJson {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes,
    createdAt: t.createdAt.toISOString(),
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

/** Why `principal` may not manage tokens, or null when it may. */
function adminRefusal(principal: Principal): "session_required" | "forbidden" | null {
  // Tokens never mint tokens: a leaked token must not be able to make itself a spare.
  if (principal.actor.type !== "user") return "session_required";
  return principal.scopes.has("workspace:admin") ? null : "forbidden";
}

export function registerTokenRoutes(app: OpenAPIHono, deps: TokenRoutesDeps): void {
  const auth = requirePrincipal(deps.authenticate);
  app.use("/v1/tokens", auth);
  app.use("/v1/tokens/*", auth);

  app.openapi(createTokenRoute, async (c) => {
    const principal = c.get("principal");
    const { name, scopes } = c.req.valid("json");
    // No one can hand an agent more than they hold themselves.
    if (scopes.some((s) => !principal.scopes.has(s))) {
      return c.json({ error: "scope_not_held" }, 403);
    }
    const { row, token } = await deps.db.withTenant(principal.tenantId, (tx) =>
      createApiToken(tx, {
        tenantId: principal.tenantId,
        name,
        scopes,
        actor: principal.actor,
        requestId: c.get("requestId"),
      }),
    );
    // Never cached: the response is the only copy of the token.
    c.header("Cache-Control", "no-store");
    return c.json({ ...serialize(row), token }, 201);
  });

  app.openapi(listTokensRoute, async (c) => {
    const principal = c.get("principal");
    const rows = await deps.db.withTenant(principal.tenantId, (tx) =>
      tx.select().from(apiTokens).orderBy(asc(apiTokens.createdAt), asc(apiTokens.id)),
    );
    return c.json({ tokens: rows.map(serialize) }, 200);
  });

  app.openapi(revokeTokenRoute, async (c) => {
    const principal = c.get("principal");
    const { id } = c.req.valid("param");
    const isSelf = principal.actor.type === "agent" && principal.actor.id === id;
    // Checked before any lookup, so an agent learns nothing about other tokens' IDs.
    if (!isSelf && adminRefusal(principal)) return c.json({ error: "forbidden" }, 403);
    const result = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [revoked] = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
        .returning({ id: apiTokens.id });
      if (!revoked) {
        // Already revoked is done; another workspace's token looks like no token at all.
        const [found] = await tx
          .select({ id: apiTokens.id })
          .from(apiTokens)
          .where(eq(apiTokens.id, id));
        nothingToAudit("already revoked, or not found");
        return found ? "already_revoked" : "not_found";
      }
      await recordAudit(tx, {
        tenantId: principal.tenantId,
        actor: principal.actor,
        action: "api_token.revoked",
        target: { type: "api_token", id },
        requestId: c.get("requestId"),
      });
      return "revoked";
    });
    if (result === "not_found") return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
}
