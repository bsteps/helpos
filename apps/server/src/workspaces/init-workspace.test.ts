import { type AuthStore, createAuthStore, createDatabase, type Database, schema } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "./init-workspace.ts";

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
});

afterAll(async () => {
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

const input = { workspace: "Acme", mailbox: "Support@Acme.test", owner: "you@acme.test" };

describe("initWorkspace", () => {
  it("creates a workspace, mailbox and owner membership", async () => {
    const result = await initWorkspace({ db, auth }, input);
    expect(result).toMatchObject({ ok: true, created: true });
    if (!result.ok) return;

    expect(await db.resolveMailbox("support@acme.test")).toMatchObject({
      tenantId: result.tenantId,
    });
    const owner = await auth.ensureUser("you@acme.test");
    expect(await db.listMemberships(owner.id)).toEqual([
      { tenantId: result.tenantId, role: "owner" },
    ]);
  });

  it("is idempotent", async () => {
    const first = await initWorkspace({ db, auth }, input);
    const second = await initWorkspace({ db, auth }, input);
    expect(second).toEqual(first.ok ? { ...first, created: false } : first);
    if (!second.ok) return;
    const tenantRows = await db.withTenant(second.tenantId, (tx) =>
      tx.select().from(schema.tenants),
    );
    expect(tenantRows).toHaveLength(1);
  });

  it("reports a taken address generically when another workspace wins a race", async () => {
    // Simulate the race: the lookup misses, then the insert hits the unique constraint.
    const racingDb = { ...db, withTenant: db.withTenant, resolveMailbox: async () => null };
    const result = await initWorkspace({ db: racingDb, auth }, { ...input, workspace: "Copycat" });
    expect(result).toEqual({ ok: false, reason: "mailbox_not_available" });
  });

  it("rejects an invalid mailbox address", async () => {
    await expect(
      initWorkspace({ db, auth }, { ...input, mailbox: "not-an-email" }),
    ).rejects.toThrow();
  });
});
