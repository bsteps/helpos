import { type ApiTokenScope, schema, type TenantTx, uuidv7 } from "@helpos/db";
import { type AuditActor, recordAudit } from "../audit/audit.ts";
import { generateToken } from "./token.ts";

export type ApiTokenRow = typeof schema.apiTokens.$inferSelect;

/**
 * Creates an agent token and its audit event, in the caller's transaction. Returns the token
 * itself: this is the only time it exists outside the caller's hands, so show it once and
 * never log it.
 */
export async function createApiToken(
  tx: TenantTx,
  input: {
    tenantId: string;
    name: string;
    scopes: ApiTokenScope[];
    actor: AuditActor;
    requestId: string | null;
  },
): Promise<{ row: ApiTokenRow; token: string }> {
  const { token, hash } = generateToken();
  const id = uuidv7();
  const [row] = await tx
    .insert(schema.apiTokens)
    .values({
      id,
      tenantId: input.tenantId,
      name: input.name,
      tokenHash: hash,
      // Stored sorted and without repeats, so equal grants look equal.
      scopes: [...new Set(input.scopes)].sort(),
    })
    .returning();
  if (!row) throw new Error("create api token: insert returned no row");
  await recordAudit(tx, {
    tenantId: input.tenantId,
    actor: input.actor,
    action: "api_token.created",
    target: { type: "api_token", id },
    requestId: input.requestId,
  });
  return { row, token };
}
