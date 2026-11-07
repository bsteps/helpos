import { type AuthStore, type Database, isUniqueViolation, schema, uuidv7 } from "@helpos/db";
import { z } from "zod";

export const initWorkspaceInput = z.object({
  workspace: z.string().trim().min(1).max(200),
  mailbox: z.email().trim().toLowerCase(),
  owner: z.email().trim().toLowerCase(),
});

export type InitWorkspaceInput = z.input<typeof initWorkspaceInput>;

export type InitWorkspaceResult =
  | { ok: true; tenantId: string; created: boolean }
  /** ADR 0009 §7: a generic answer that never says which workspace has the address. */
  | { ok: false; reason: "mailbox_not_available" };

/**
 * Creates a workspace, its support mailbox and its owner. Idempotent: the mailbox address
 * identifies the workspace, so running it again only adds whatever is missing.
 */
export async function initWorkspace(
  deps: {
    db: Pick<Database, "withTenant" | "resolveMailbox">;
    auth: Pick<AuthStore, "ensureUser">;
  },
  rawInput: InitWorkspaceInput,
): Promise<InitWorkspaceResult> {
  const input = initWorkspaceInput.parse(rawInput);
  const owner = await deps.auth.ensureUser(input.owner);

  const existing = await deps.db.resolveMailbox(input.mailbox);
  const tenantId = existing?.tenantId ?? uuidv7();

  try {
    await deps.db.withTenant(tenantId, async (tx) => {
      if (!existing) {
        // Shadow mode starts on, sending replies to the owner until someone changes it.
        await tx
          .insert(schema.tenants)
          .values({ id: tenantId, name: input.workspace, shadowRecipient: input.owner });
        await tx.insert(schema.mailboxes).values({ tenantId, address: input.mailbox });
      }
      await tx
        .insert(schema.memberships)
        .values({ tenantId, userId: owner.id, role: "owner" })
        .onConflictDoNothing({ target: [schema.memberships.tenantId, schema.memberships.userId] });
    });
  } catch (error) {
    // Another workspace claimed the address between the lookup and the insert.
    if (isUniqueViolation(error, "mailboxes_address")) {
      return { ok: false, reason: "mailbox_not_available" };
    }
    throw error;
  }
  return { ok: true, tenantId, created: !existing };
}
