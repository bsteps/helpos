import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDatabase, type Database } from "./client.ts";
import { createJobRunner, defineTenantJob, enqueue, type JobRunner } from "./jobs.ts";
import { customers, mailboxes, tenants, tickets } from "./schema.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

// ADR 0009 §2 and §3: jobs carry a tenant, run inside withTenant(), and the app role can only
// enqueue, never read or change pg-boss's tables.

let testDb: TestDatabase;
let db: Database;
let runner: JobRunner;
let jobsSql: postgres.Sql;
let appSql: postgres.Sql;

const tenantA = uuidv7();
const tenantB = uuidv7();
const probe = defineTenantJob("test-probe", { ticketId: z.uuid() });
const idle = defineTenantJob("test-idle", { ticketId: z.uuid() });

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  jobsSql = postgres(testDb.jobsUrl, { max: 1, onnotice: () => {} });
  appSql = postgres(testDb.appUrl, { max: 1, onnotice: () => {} });
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: (error) => {
      throw error;
    },
    pollingIntervalSeconds: 0.5,
  });
  await runner.start();
  for (const id of [tenantA, tenantB]) {
    await db.withTenant(id, (tx) => tx.insert(tenants).values({ id, name: id }));
  }
  // Created but never worked, so enqueued jobs stay put for inspection.
  await runner.ensureQueue(idle);
});

afterAll(async () => {
  await runner?.stop();
  await jobsSql?.end();
  await appSql?.end();
  await db?.close();
  await testDb?.container.stop();
});

async function jobCount(queue: string): Promise<number> {
  const [row] = await jobsSql<{ n: number }[]>`
    select count(*)::int as n from pgboss.job where name = ${queue}`;
  return row?.n ?? 0;
}

/** Error messages along the cause chain: Drizzle wraps the Postgres error. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
    return messages.join(" | ");
  }
  throw new Error("expected the call to fail");
}

/** Calls app_enqueue() directly, as A, skipping the TypeScript helper's checks. */
function rawEnqueueAsA(payload: object, options: object = {}) {
  return db.withTenant(tenantA, (tx) =>
    tx.execute(
      sql`select jobs_api.app_enqueue('test-idle', ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(options)}::jsonb)`,
    ),
  );
}

describe("enqueue", () => {
  it("enqueue rejects a tenant job without tenantId", async () => {
    const before = await jobCount("test-idle");
    const helper = failure(
      db.withTenant(tenantA, (tx) =>
        // Simulates a caller that bypasses the types.
        enqueue(tx, idle, { ticketId: uuidv7() } as unknown as z.infer<typeof idle.payload>),
      ),
    );
    expect(await helper).toMatch(/tenantId/);
    expect(await failure(rawEnqueueAsA({ ticketId: uuidv7() }))).toMatch(
      /payload tenantId must be the current tenant/,
    );
    expect(await jobCount("test-idle")).toBe(before);
  });

  it("rejects a payload with content beyond IDs", async () => {
    const extra = { tenantId: tenantA, ticketId: uuidv7(), body: "hello" };
    const message = await failure(
      db.withTenant(tenantA, (tx) => enqueue(tx, idle, extra as z.infer<typeof idle.payload>)),
    );
    expect(message).toMatch(/body/);
  });

  it("rejects a job for another tenant, even through the raw function", async () => {
    const before = await jobCount("test-idle");
    expect(
      await failure(
        db.withTenant(tenantA, (tx) =>
          enqueue(tx, idle, { tenantId: tenantB, ticketId: uuidv7() }),
        ),
      ),
    ).toMatch(/payload tenantId must be the current tenant/);
    expect(await failure(rawEnqueueAsA({ tenantId: tenantB }))).toMatch(
      /payload tenantId must be the current tenant/,
    );
    expect(await jobCount("test-idle")).toBe(before);
  });

  it("enqueue commits atomically with the action", async () => {
    const before = await jobCount("test-idle");
    const ticketId = uuidv7();
    await expect(
      db.withTenant(tenantA, async (tx) => {
        await enqueue(tx, idle, { tenantId: tenantA, ticketId });
        throw new Error("action failed after enqueue");
      }),
    ).rejects.toThrow("action failed");
    expect(await jobCount("test-idle")).toBe(before);

    await db.withTenant(tenantA, (tx) => enqueue(tx, idle, { tenantId: tenantA, ticketId }));
    expect(await jobCount("test-idle")).toBe(before + 1);
  });

  it("app_enqueue returns the existing job ID for a duplicate singleton key", async () => {
    const send = (tenantId: string) =>
      db.withTenant(tenantId, (tx) =>
        enqueue(tx, idle, { tenantId, ticketId: uuidv7() }, { singletonKey: "same" }),
      );
    const first = await send(tenantA);
    expect(await send(tenantA)).toBe(first);
    // The key is scoped to the tenant: B never dedupes against, or learns, A's job ID.
    expect(await send(tenantB)).not.toBe(first);
  });

  it("refuses options it does not support", async () => {
    expect(await failure(rawEnqueueAsA({ tenantId: tenantA }, { priority: 9 }))).toMatch(
      /unsupported option/,
    );
  });
});

describe("leak: pg-boss tables", () => {
  it("leak: app role cannot select, update or delete pgboss jobs", async () => {
    await expect(appSql`select * from pgboss.job`).rejects.toThrow(/permission denied/);
    await expect(appSql`update pgboss.job set priority = 1`).rejects.toThrow(/permission denied/);
    await expect(appSql`delete from pgboss.job`).rejects.toThrow(/permission denied/);
  });
});

describe("job runner", () => {
  it("leak: job for tenant A cannot read tenant B rows", async () => {
    const bTicket = uuidv7();
    await db.withTenant(tenantB, async (tx) => {
      const mailboxId = uuidv7();
      const customerId = uuidv7();
      await tx
        .insert(mailboxes)
        .values({ id: mailboxId, tenantId: tenantB, address: "jobs@b.test" });
      await tx.insert(customers).values({ id: customerId, tenantId: tenantB, email: "c@b.test" });
      await tx
        .insert(tickets)
        .values({ id: bTicket, tenantId: tenantB, customerId, mailboxId, subject: "B only" });
    });

    const seen = new Promise<{ tenant: string | undefined; ticketCount: number }>(
      (resolve, reject) => {
        void runner
          .work(probe, async (payload, tx) => {
            const rows = await tx.select().from(tickets);
            const [setting] = await tx.execute<{ t: string }>(
              "select current_setting('app.tenant_id', true) as t",
            );
            expect(payload.ticketId).toBe(bTicket);
            resolve({ tenant: setting?.t, ticketCount: rows.length });
          })
          .catch(reject);
      },
    );
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, probe, { tenantId: tenantA, ticketId: bTicket }),
    );
    expect(await seen).toEqual({ tenant: tenantA, ticketCount: 0 });
  });
});
