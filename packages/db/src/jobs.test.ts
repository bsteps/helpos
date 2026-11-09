import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDatabase, type Database } from "./client.ts";
import { createJobRunner, defineTenantJob, enqueue, type JobRunner } from "./jobs.ts";
import { customers, mailboxes, tenants, tickets } from "./schema.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

// Jobs carry a tenant, run inside withTenant(), and the app role can only
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

    let resolveSeen: (value: { tenant: string | undefined; ticketCount: number }) => void =
      () => {};
    const seen = new Promise<{ tenant: string | undefined; ticketCount: number }>((resolve) => {
      resolveSeen = resolve;
    });
    // Awaited, so the queue exists before the enqueue below.
    await runner.work(probe, async (_payload, tx) => {
      const rows = await tx.select().from(tickets);
      const [setting] = await tx.execute<{ t: string }>(
        "select current_setting('app.tenant_id', true) as t",
      );
      resolveSeen({ tenant: setting?.t, ticketCount: rows.length });
    });
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, probe, { tenantId: tenantA, ticketId: bTicket }),
    );
    expect(await seen).toEqual({ tenant: tenantA, ticketCount: 0 });
  });

  it("leak: a steps job opens separate transactions, each one only as its own tenant", async () => {
    type Step = { tenant: string | undefined; txid: string; tickets: number };
    let resolveSeen: (steps: Step[]) => void = () => {};
    const seen = new Promise<Step[]>((resolve) => {
      resolveSeen = resolve;
    });
    const stepsProbe = defineTenantJob("test-steps-probe", { ticketId: z.uuid() });
    await runner.workInSteps(stepsProbe, async (_payload, transaction) => {
      const steps: Step[] = [];
      for (let i = 0; i < 2; i++) {
        steps.push(
          await transaction(async (tx) => {
            const [row] = await tx.execute<{ t: string; txid: string }>(
              "select current_setting('app.tenant_id', true) as t, txid_current()::text as txid",
            );
            const rows = await tx.select().from(tickets);
            return { tenant: row?.t, txid: row?.txid ?? "", tickets: rows.length };
          }),
        );
      }
      resolveSeen(steps);
    });
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, stepsProbe, { tenantId: tenantA, ticketId: uuidv7() }),
    );
    const [first, second] = await seen;
    // Tenant B has a ticket (seeded above); tenant A has none.
    expect(first).toMatchObject({ tenant: tenantA, tickets: 0 });
    expect(second).toMatchObject({ tenant: tenantA, tickets: 0 });
    expect(first?.txid).not.toBe(second?.txid);
  });
  it("retries as the queue's policy says, then gives up once, in a fresh transaction", async () => {
    const flaky = defineTenantJob("test-give-up", { ticketId: z.uuid() });
    await runner.ensureQueue(flaky, { limit: 2, delaySeconds: 1, backoff: false });
    let attempts = 0;
    let resolveGaveUp: (tenant: string | undefined) => void = () => {};
    const gaveUp = new Promise<string | undefined>((resolve) => {
      resolveGaveUp = resolve;
    });
    let giveUps = 0;
    await runner.work(
      flaky,
      async () => {
        attempts++;
        throw new Error("always fails");
      },
      {
        onGiveUp: async (_payload, tx) => {
          giveUps++;
          const [row] = await tx.execute<{ t: string }>(
            "select current_setting('app.tenant_id', true) as t",
          );
          resolveGaveUp(row?.t);
        },
      },
    );
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, flaky, { tenantId: tenantA, ticketId: uuidv7() }),
    );
    expect(await gaveUp).toBe(tenantA);
    // The first attempt and two retries, and only the last one gives up.
    expect(attempts).toBe(3);
    expect(giveUps).toBe(1);
    const [job] = await jobsSql<{ state: string; retry_limit: number }[]>`
      select state, retry_limit from pgboss.job where name = ${flaky.queue}`;
    expect(job?.retry_limit).toBe(2);
  });
});
