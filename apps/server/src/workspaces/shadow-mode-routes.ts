import { type Database, eq, schema } from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import { nothingToAudit } from "../audit/audit.ts";
import { apiRoute } from "../auth/access.ts";
import { auditor, errorResponse, errorSchema, json, jsonBody } from "../http/route-kit.ts";

const { tenants } = schema;

export interface ShadowModeRouteDeps {
  db: Pick<Database, "withTenant">;
  /** HELPOS_ALLOW_SHADOW_MODE_OFF. While false, shadow mode can't be turned off. */
  allowShadowModeOff: boolean;
}

const shadowModeSchema = z
  .object({
    /** On: every reply goes to `recipient`, never to the customer. */
    enabled: z.boolean(),
    /** Where replies go in shadow mode. Null: approved replies wait until one is set. */
    recipient: z.email().nullable(),
  })
  .openapi("ShadowMode");
const path = "/v1/workspace/shadow-mode";

const getRoute = apiRoute({
  access: { allScopes: ["conversations:read"] },
  method: "get",
  path,
  summary: "Read the workspace's shadow mode",
  description:
    "Whether replies go to the shadow recipient instead of customers. Needs `conversations:read`.",
  responses: { 200: json(shadowModeSchema, "Shadow mode") },
});

const patchRoute = apiRoute({
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  audit: {
    records: [
      "workspace.shadow_mode_enabled",
      "workspace.shadow_mode_disabled",
      "workspace.shadow_recipient_changed",
    ],
  },
  method: "patch",
  path,
  summary: "Change the workspace's shadow mode",
  description:
    "Sets the shadow recipient, or turns shadow mode on or off. Every change is audit-logged. " +
    "Turning it off lets replies reach real customers, so it is refused (`shadow_mode_locked`) " +
    "unless the server allows it. Needs a human session with `workspace:admin`.",
  request: {
    body: jsonBody(
      z
        .strictObject({
          enabled: z.boolean().optional(),
          recipient: z.email().trim().toLowerCase().optional(),
        })
        .refine((b) => b.enabled !== undefined || b.recipient !== undefined, {
          message: "nothing to change",
        }),
    ),
  },
  responses: {
    200: json(shadowModeSchema, "The updated shadow mode"),
    409: json(errorSchema, "Turning shadow mode off is not allowed on this server"),
  },
});

export function registerShadowModeRoutes(app: OpenAPIHono, deps: ShadowModeRouteDeps): void {
  app.openapi(getRoute, async (c) => {
    const principal = c.get("principal");
    const [row] = await deps.db.withTenant(principal.tenantId, (tx) =>
      tx
        .select({ enabled: tenants.shadowMode, recipient: tenants.shadowRecipient })
        .from(tenants)
        .where(eq(tenants.id, principal.tenantId)),
    );
    if (!row) throw new Error("shadow mode: workspace row missing");
    return c.json(row, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = c.get("principal");
    const input = c.req.valid("json");
    const audit = auditor(c);
    if (input.enabled === false && !deps.allowShadowModeOff) {
      return errorResponse(c, { error: "shadow_mode_locked" }, 409);
    }
    const row = await deps.db.withTenant(principal.tenantId, async (tx) => {
      const [updated] = await tx
        .update(tenants)
        .set({
          ...(input.enabled !== undefined ? { shadowMode: input.enabled } : {}),
          ...(input.recipient !== undefined ? { shadowRecipient: input.recipient } : {}),
        })
        .where(eq(tenants.id, principal.tenantId))
        .returning({ enabled: tenants.shadowMode, recipient: tenants.shadowRecipient });
      if (!updated) throw new Error("shadow mode: workspace row missing");
      // In the same transaction: the change and its audit events commit together. One event
      // per kind of change, so the log says plainly when replies started reaching customers.
      const actions = [
        ...(input.enabled === true ? (["workspace.shadow_mode_enabled"] as const) : []),
        ...(input.enabled === false ? (["workspace.shadow_mode_disabled"] as const) : []),
        ...(input.recipient !== undefined ? (["workspace.shadow_recipient_changed"] as const) : []),
      ];
      if (actions.length === 0) nothingToAudit("no field given");
      for (const action of actions) {
        await audit(tx, action, { type: "workspace", id: principal.tenantId });
      }
      return updated;
    });
    return c.json(row, 200);
  });
}
