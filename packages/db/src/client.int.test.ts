import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client.ts";
import { tenants } from "./schema.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
});

afterAll(async () => {
  await db?.close();
  await testDb?.stop();
});

const tenantA = "00000000-0000-4000-8000-00000000000a";

describe("app role (ADR 0003)", () => {
  it("cannot bypass row-level security", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
        sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
      ),
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("cannot change the schema", async () => {
    await expect(
      db.withTenant(tenantA, (tx) => tx.execute(sql`create table x (id int)`)),
    ).rejects.toThrow();
  });

  it("can read migrated tables", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.execute(sql`select count(*) from tenants`),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("withTenant", () => {
  it("sets app.tenant_id inside the transaction", async () => {
    const rows = await db.withTenant(tenantA, (tx) =>
      tx.execute<{ id: string }>(sql`select current_setting('app.tenant_id') as id`),
    );
    expect(rows[0]?.id).toBe(tenantA);
  });

  it("does not leak the tenant to the next request on a pooled connection", async () => {
    const client = postgres(testDb.appUrl, { max: 1 });
    const pooledDb = createDatabase(client);
    try {
      const [connection] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
      expect(connection).toBeDefined();
      for (const tenantId of [tenantA, "00000000-0000-4000-8000-00000000000b"]) {
        const inside = await pooledDb.withTenant(tenantId, (tx) =>
          tx.execute<{ pid: number; id: string }>(
            sql`select pg_backend_pid() as pid, current_setting('app.tenant_id') as id`,
          ),
        );
        expect([...inside]).toEqual([{ pid: connection?.pid, id: tenantId }]);
        const outside = await client<{ pid: number; id: string | null }[]>`
          select pg_backend_pid() as pid, nullif(current_setting('app.tenant_id', true), '') as id
        `;
        expect([...outside]).toEqual([{ pid: connection?.pid, id: null }]);
      }
    } finally {
      await pooledDb.close();
    }
  });

  it("rolls back writes and rethrows the same callback error", async () => {
    const tenantId = "00000000-0000-4000-8000-00000000000c";
    const error = new Error("callback failed after insert");
    await expect(
      db.withTenant(tenantId, async (tx) => {
        await tx.insert(tenants).values({ id: tenantId, name: "Rolled back" });
        expect(await tx.select({ id: tenants.id }).from(tenants)).toEqual([{ id: tenantId }]);
        throw error;
      }),
    ).rejects.toBe(error);
    const remaining = await db.withTenant(tenantId, (tx) => tx.select().from(tenants));
    expect(remaining).toEqual([]);
    await db.withTenant(tenantId, (tx) =>
      tx.insert(tenants).values({ id: tenantId, name: "Committed" }),
    );
    const committed = await db.withTenant(tenantId, (tx) =>
      tx.select({ id: tenants.id, name: tenants.name }).from(tenants),
    );
    expect(committed).toEqual([{ id: tenantId, name: "Committed" }]);
  });

  it("rejects a tenant id that is not a UUID", async () => {
    await expect(db.withTenant("not-a-uuid", async () => 1)).rejects.toThrow();
  });
});

describe("ping", () => {
  it("is true when the database is reachable", async () => {
    expect(await db.ping()).toEqual({ ok: true });
  });

  it("is false, without throwing, when it is not", async () => {
    const down = createDatabase("postgres://nobody:nothing@127.0.0.1:1/none");
    try {
      const result = await down.ping();
      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : result.error).toBeInstanceOf(Error);
    } finally {
      await down.close();
    }
  });
});

describe("tenants table RLS (ADR 0003)", () => {
  const tenantB = "00000000-0000-4000-8000-00000000000b";

  it("lets a tenant create and read only its own row", async () => {
    await db.withTenant(tenantA, (tx) => tx.insert(tenants).values({ id: tenantA, name: "A" }));

    // Acting as A, writing B's row is refused by the database itself.
    await expect(
      db.withTenant(tenantA, (tx) => tx.insert(tenants).values({ id: tenantB, name: "B" })),
    ).rejects.toThrow();

    await db.withTenant(tenantB, (tx) => tx.insert(tenants).values({ id: tenantB, name: "B" }));
    const seenByA = await db.withTenant(tenantA, (tx) => tx.select().from(tenants));
    expect(seenByA.map((t) => t.id)).toEqual([tenantA]);
  });
});
