import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createDatabase, type Database } from "./client.ts";
import { createJobRunner, defineTenantJob, enqueue, type JobRunner } from "./jobs.ts";
import { conversations, customers, mailboxes, tenants } from "./schema.ts";
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
const probe = defineTenantJob("test-probe", { conversationId: z.uuid() });
const idle = defineTenantJob("test-idle", { conversationId: z.uuid() });

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
  await testDb?.stop();
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
  it("reserves system queues even when a caller bypasses the tenant helper", async () => {
    expect(() => defineTenantJob("system.cleanup", {})).toThrow(/tenant queue cannot use/);
    expect(
      await failure(
        db.withTenant(tenantA, (tx) =>
          tx.execute(
            sql`select jobs_api.app_enqueue('system.cleanup', ${JSON.stringify({ tenantId: tenantA })}::jsonb, '{}'::jsonb)`,
          ),
        ),
      ),
    ).toMatch(/only tenant queues/);
  });

  it("enqueue rejects a tenant job without tenantId", async () => {
    const before = await jobCount("test-idle");
    const helper = failure(
      db.withTenant(tenantA, (tx) =>
        // Simulates a caller that bypasses the types.
        enqueue(tx, idle, { conversationId: uuidv7() } as unknown as z.infer<typeof idle.payload>),
      ),
    );
    expect(await helper).toMatch(/tenantId/);
    expect(await failure(rawEnqueueAsA({ conversationId: uuidv7() }))).toMatch(
      /payload tenantId must be the current tenant/,
    );
    expect(await jobCount("test-idle")).toBe(before);
  });

  it("rejects a payload with content beyond IDs", async () => {
    const extra = { tenantId: tenantA, conversationId: uuidv7(), body: "hello" };
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
          enqueue(tx, idle, { tenantId: tenantB, conversationId: uuidv7() }),
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
    const conversationId = uuidv7();
    await expect(
      db.withTenant(tenantA, async (tx) => {
        await enqueue(tx, idle, { tenantId: tenantA, conversationId });
        throw new Error("action failed after enqueue");
      }),
    ).rejects.toThrow("action failed");
    expect(await jobCount("test-idle")).toBe(before);

    await db.withTenant(tenantA, (tx) => enqueue(tx, idle, { tenantId: tenantA, conversationId }));
    expect(await jobCount("test-idle")).toBe(before + 1);
  });

  it("app_enqueue returns the existing job ID for a duplicate singleton key", async () => {
    const send = (tenantId: string) =>
      db.withTenant(tenantId, (tx) =>
        enqueue(tx, idle, { tenantId, conversationId: uuidv7() }, { singletonKey: "same" }),
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
  it.each(["transaction", "steps"] as const)(
    "reports an invalid stored %s payload on its last attempt",
    async (mode) => {
      const job = defineTenantJob(`test-invalid-${mode}`, { ticketId: z.uuid() });
      const onError = vi.fn();
      const handler = vi.fn();
      const onGiveUp = vi.fn();
      const invalidRunner = createJobRunner({
        jobsUrl: testDb.jobsUrl,
        db,
        onError,
        pollingIntervalSeconds: 0.5,
      });
      await invalidRunner.start();
      try {
        await invalidRunner.ensureQueue(job, { limit: 1, delaySeconds: 1, backoff: false });
        const id = await db.withTenant(tenantA, (tx) =>
          enqueue(tx, job, { tenantId: tenantA, ticketId: uuidv7() }),
        );
        const secret = "private-customer-payload";
        await jobsSql`update pgboss.job set data = ${JSON.stringify({ [secret]: secret })}::jsonb where id = ${id}`;
        await invalidRunner.work(
          job,
          mode === "transaction"
            ? { transaction: handler, onGiveUp }
            : { steps: handler, onGiveUp },
        );
        await expect
          .poll(
            async () => {
              const [row] =
                await jobsSql`select state, retry_count from pgboss.job where id = ${id}`;
              return row;
            },
            { timeout: 20_000 },
          )
          .toEqual({ state: "failed", retry_count: 1 });
        expect(handler).not.toHaveBeenCalled();
        expect(onGiveUp).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ name: "InvalidJobPayloadError" }),
          { queue: job.queue, jobId: id },
        );
        expect(String(onError.mock.calls[0]?.[0])).not.toContain(secret);
        const [row] = await jobsSql`select output from pgboss.job where id = ${id}`;
        expect(JSON.stringify(row)).not.toContain(secret);
      } finally {
        await invalidRunner.stop();
      }
    },
  );

  it("leak: job for tenant A cannot read tenant B rows", async () => {
    const bConversation = uuidv7();
    await db.withTenant(tenantB, async (tx) => {
      const mailboxId = uuidv7();
      const customerId = uuidv7();
      await tx
        .insert(mailboxes)
        .values({ id: mailboxId, tenantId: tenantB, address: "jobs@b.test" });
      await tx.insert(customers).values({ id: customerId, tenantId: tenantB, email: "c@b.test" });
      await tx
        .insert(conversations)
        .values({ id: bConversation, tenantId: tenantB, customerId, mailboxId, subject: "B only" });
    });

    let resolveSeen: (value: { tenant: string | undefined; conversationCount: number }) => void =
      () => {};
    const seen = new Promise<{ tenant: string | undefined; conversationCount: number }>(
      (resolve) => {
        resolveSeen = resolve;
      },
    );
    // Awaited, so the queue exists before the enqueue below.
    await runner.work(probe, {
      transaction: async (_payload, tx) => {
        const rows = await tx.select().from(conversations);
        const [setting] = await tx.execute<{ t: string }>(
          "select current_setting('app.tenant_id', true) as t",
        );
        resolveSeen({ tenant: setting?.t, conversationCount: rows.length });
      },
      onGiveUp: async () => {},
    });
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, probe, { tenantId: tenantA, conversationId: bConversation }),
    );
    expect(await seen).toEqual({ tenant: tenantA, conversationCount: 0 });
  });

  it("leak: a steps job opens separate transactions, each one only as its own tenant", async () => {
    type Step = { tenant: string | undefined; txid: string; conversations: number };
    let resolveSeen: (steps: Step[]) => void = () => {};
    const seen = new Promise<Step[]>((resolve) => {
      resolveSeen = resolve;
    });
    const stepsProbe = defineTenantJob("test-steps-probe", { conversationId: z.uuid() });
    await runner.work(stepsProbe, {
      steps: async (_payload, transaction) => {
        const steps: Step[] = [];
        for (let i = 0; i < 2; i++) {
          steps.push(
            await transaction(async (tx) => {
              const [row] = await tx.execute<{ t: string; txid: string }>(
                "select current_setting('app.tenant_id', true) as t, txid_current()::text as txid",
              );
              const rows = await tx.select().from(conversations);
              return { tenant: row?.t, txid: row?.txid ?? "", conversations: rows.length };
            }),
          );
        }
        resolveSeen(steps);
      },
      onGiveUp: async () => {},
    });
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, stepsProbe, { tenantId: tenantA, conversationId: uuidv7() }),
    );
    const [first, second] = await seen;
    // Tenant B has a conversation (seeded above); tenant A has none.
    expect(first).toMatchObject({ tenant: tenantA, conversations: 0 });
    expect(second).toMatchObject({ tenant: tenantA, conversations: 0 });
    expect(first?.txid).not.toBe(second?.txid);
  });
  it("retries as the queue's policy says, then gives up once, in a fresh transaction", async () => {
    const flaky = defineTenantJob("test-give-up", { conversationId: z.uuid() });
    await runner.ensureQueue(flaky, { limit: 2, delaySeconds: 1, backoff: false });
    let attempts = 0;
    let resolveGaveUp: (tenant: string | undefined) => void = () => {};
    const gaveUp = new Promise<string | undefined>((resolve) => {
      resolveGaveUp = resolve;
    });
    let giveUps = 0;
    await runner.work(flaky, {
      transaction: async () => {
        attempts++;
        throw new Error("always fails");
      },
      onGiveUp: async (_payload, tx) => {
        giveUps++;
        const [row] = await tx.execute<{ t: string }>(
          "select current_setting('app.tenant_id', true) as t",
        );
        resolveGaveUp(row?.t);
      },
    });
    await db.withTenant(tenantA, (tx) =>
      enqueue(tx, flaky, { tenantId: tenantA, conversationId: uuidv7() }),
    );
    expect(await gaveUp).toBe(tenantA);
    // The first attempt and two retries, and only the last one gives up.
    expect(attempts).toBe(3);
    expect(giveUps).toBe(1);
    const [job] = await jobsSql<{ state: string; retry_limit: number }[]>`
      select state, retry_limit from pgboss.job where name = ${flaky.queue}`;
    expect(job?.retry_limit).toBe(2);
  });

  it("gives up a steps job too, once, as its own tenant", async () => {
    const flakySteps = defineTenantJob("test-give-up-steps", { conversationId: z.uuid() });
    await runner.ensureQueue(flakySteps, { limit: 1, delaySeconds: 1, backoff: false });
    let attempts = 0;
    let giveUps = 0;
    let resolveGaveUp: (tenant: string | undefined) => void = () => {};
    const gaveUp = new Promise<string | undefined>((resolve) => {
      resolveGaveUp = resolve;
    });
    await runner.work(flakySteps, {
      steps: async (_payload, transaction) => {
        attempts++;
        await transaction(async () => {
          throw new Error("always fails");
        });
      },
      onGiveUp: async (_payload, tx) => {
        giveUps++;
        const [row] = await tx.execute<{ t: string }>(
          "select current_setting('app.tenant_id', true) as t",
        );
        resolveGaveUp(row?.t);
      },
    });
    await db.withTenant(tenantB, (tx) =>
      enqueue(tx, flakySteps, { tenantId: tenantB, conversationId: uuidv7() }),
    );
    expect(await gaveUp).toBe(tenantB);
    expect(attempts).toBe(2);
    expect(giveUps).toBe(1);
  });
});
