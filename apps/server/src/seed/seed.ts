import { type AuthStore, type Database, enqueue, type JobRunner, schema } from "@helpos/db";
import { ingestSourceJob } from "../knowledge/jobs.ts";
import { hashToken } from "../tokens/token.ts";
import { buildDemoData, type DemoData } from "./demo-data.ts";

export type SeedResult =
  | { ok: true; data: DemoData }
  /** Another workspace already has one of the demo mailboxes: we never write into it. */
  | { ok: false; reason: "mailbox_taken"; mailbox: string };

/**
 * Writes the demo data, one transaction per workspace through withTenant(). Safe to run again:
 * every row has a fixed ID and is inserted only if missing, so a second run changes nothing.
 * Knowledge sources are queued for ingestion like any new source, so the worker embeds them
 * with whichever embedding model is configured.
 */
export async function seedDemoData(deps: {
  db: Pick<Database, "withTenant" | "resolveMailbox">;
  auth: Pick<AuthStore, "ensureUser">;
  /** Creates the ingest queue: enqueue() refuses one no worker has created yet. */
  jobs: Pick<JobRunner, "ensureQueue">;
}): Promise<SeedResult> {
  const data = buildDemoData();

  for (const t of data.tenants) {
    const route = await deps.db.resolveMailbox(t.mailbox.address);
    if (route && route.tenantId !== t.tenant.id) {
      return { ok: false, reason: "mailbox_taken", mailbox: t.mailbox.address };
    }
  }

  await deps.jobs.ensureQueue(ingestSourceJob);
  const userIds = new Map<string, string>();
  for (const u of data.users) userIds.set(u.email, (await deps.auth.ensureUser(u.email)).id);

  for (const t of data.tenants) {
    await deps.db.withTenant(t.tenant.id, async (tx) => {
      await tx.insert(schema.tenants).values(t.tenant).onConflictDoNothing();
      await tx.insert(schema.mailboxes).values(t.mailbox).onConflictDoNothing();
      await tx
        .insert(schema.memberships)
        .values(
          t.memberships.map(({ email, ...m }) => {
            const userId = userIds.get(email);
            if (!userId) throw new Error(`seed: no user for ${email}`);
            return { ...m, userId };
          }),
        )
        .onConflictDoNothing();
      await tx.insert(schema.customers).values(t.customers).onConflictDoNothing();
      await tx
        .insert(schema.apiTokens)
        .values(t.tokens.map(({ token, ...row }) => ({ ...row, tokenHash: hashToken(token) })))
        .onConflictDoNothing();
      await tx.insert(schema.auditEvents).values(t.audit).onConflictDoNothing();
      await tx.insert(schema.tickets).values(t.tickets).onConflictDoNothing();
      await tx.insert(schema.messages).values(t.messages).onConflictDoNothing();
      await tx.insert(schema.drafts).values(t.drafts).onConflictDoNothing();
      // Inserted before the citations that point at them; only new ones are queued.
      const added = await tx
        .insert(schema.knowledgeSources)
        .values(t.sources)
        .onConflictDoNothing()
        .returning({ id: schema.knowledgeSources.id });
      await tx.insert(schema.draftCitations).values(t.citations).onConflictDoNothing();
      for (const { id } of added) {
        await enqueue(
          tx,
          ingestSourceJob,
          { tenantId: t.tenant.id, sourceId: id },
          { singletonKey: id },
        );
      }
    });
  }
  return { ok: true, data };
}
