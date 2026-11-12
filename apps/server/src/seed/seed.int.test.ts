import {
  type AuthStore,
  asc,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  type JobRunner,
  schema,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../services.ts";
import { hashToken } from "../tokens/token.ts";
import { buildDemoData } from "./demo-data.ts";
import { seedDemoData } from "./seed.ts";

// The seed against real Postgres and RLS: every row goes in through withTenant(), and running
// it again leaves the database exactly as it was.

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let jobs: JobRunner;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  jobs = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await jobs.start();
});

afterAll(async () => {
  await jobs?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

/** Everything the seed wrote, read back one workspace at a time, as the app role sees it. */
async function snapshot() {
  const out: Record<string, unknown> = {};
  for (const t of buildDemoData().tenants) {
    out[t.key] = await db.withTenant(t.tenant.id, async (tx) => ({
      tenants: await tx.select().from(schema.tenants),
      mailboxes: await tx.select().from(schema.mailboxes),
      memberships: await tx.select().from(schema.memberships).orderBy(asc(schema.memberships.id)),
      customers: await tx.select().from(schema.customers).orderBy(asc(schema.customers.id)),
      apiTokens: await tx.select().from(schema.apiTokens).orderBy(asc(schema.apiTokens.id)),
      audit: await tx.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.id)),
      conversations: await tx
        .select()
        .from(schema.conversations)
        .orderBy(asc(schema.conversations.id)),
      messages: await tx.select().from(schema.messages).orderBy(asc(schema.messages.id)),
      drafts: await tx.select().from(schema.drafts).orderBy(asc(schema.drafts.id)),
      sources: await tx
        .select()
        .from(schema.knowledgeSources)
        .orderBy(asc(schema.knowledgeSources.id)),
      citations: await tx
        .select()
        .from(schema.draftCitations)
        .orderBy(asc(schema.draftCitations.id)),
    }));
  }
  return out;
}

describe("seedDemoData", () => {
  it("writes the demo data, and a second run changes nothing", async () => {
    const first = await seedDemoData({ db, auth, jobs, config: defaultConfig });
    expect(first).toMatchObject({ ok: true, skipped: [] });
    const before = await snapshot();

    // The second run finds both workspaces and leaves them alone.
    expect(await seedDemoData({ db, auth, jobs, config: defaultConfig })).toMatchObject({
      ok: true,
      skipped: ["northwind", "lumen"],
    });
    expect(await snapshot()).toEqual(before);

    // What was written is exactly what was planned, with the planned IDs.
    const plan = buildDemoData();
    for (const t of plan.tenants) {
      const got = before[t.key] as { conversations: { id: string }[]; drafts: { id: string }[] };
      expect(got.conversations.map((r) => r.id).sort()).toEqual(
        t.conversations.map((r) => r.id).sort(),
      );
      expect(got.drafts.map((r) => r.id).sort()).toEqual(t.drafts.map((r) => r.id).sort());
    }
  });

  it("stores all historical audit details exactly as planned, including unknown NULL inputs", async () => {
    let count = 0;
    let unknown = 0;
    for (const tenant of buildDemoData().tenants) {
      const stored = await db.withTenant(tenant.tenant.id, (tx) =>
        tx.select().from(schema.auditEvents).orderBy(asc(schema.auditEvents.id)),
      );
      expect(stored).toEqual(
        tenant.audit
          .map((event) => ({ ...event, details: event.details ?? null }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      count += stored.length;
      unknown += stored.filter((event) => event.details === null).length;
    }
    expect(count).toBe(35);
    expect(unknown).toBe(4);
  });

  it("keeps each workspace's data to itself", async () => {
    const [northwind, lumen] = buildDemoData().tenants;
    if (!northwind || !lumen) throw new Error("expected two demo workspaces");
    const seen = await db.withTenant(northwind.tenant.id, (tx) =>
      tx.select({ tenantId: schema.conversations.tenantId }).from(schema.conversations),
    );
    expect(seen.length).toBe(northwind.conversations.length);
    expect(seen.every((r) => r.tenantId === northwind.tenant.id)).toBe(true);
  });

  it("gives agents tokens that resolve to their workspace, and revoked ones stay revoked", async () => {
    for (const t of buildDemoData().tenants) {
      for (const k of t.tokens) {
        const found = await db.resolveApiToken(hashToken(k.token));
        expect(found).toMatchObject({ tenantId: t.tenant.id, name: k.name, scopes: k.scopes });
        expect(found?.revokedAt !== null).toBe(k.revokedAt !== null);
      }
    }
  });

  it("refuses to write into a workspace that already owns a demo mailbox", async () => {
    const mailbox = buildDemoData().tenants[0]?.mailbox.address ?? "";
    const writes: string[] = [];
    const result = await seedDemoData({
      db: {
        resolveMailbox: async (address) =>
          address === mailbox
            ? { tenantId: "0190a000-0000-7000-8000-000000000000", mailboxId: "x" }
            : null,
        withTenant: async (tenantId) => {
          writes.push(tenantId);
          throw new Error("must not write");
        },
      },
      auth: {
        ensureUser: async () => {
          throw new Error("must not create users");
        },
      },
      jobs: { ensureQueue: async () => {} },
      config: defaultConfig,
    });
    expect(result).toEqual({ ok: false, reason: "mailbox_taken", mailbox });
    expect(writes).toEqual([]);
  });
});
