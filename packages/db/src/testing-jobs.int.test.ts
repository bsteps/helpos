import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, type Database } from "./client.ts";
import { createJobRunner, defineTenantJob, enqueue, type JobRunner } from "./jobs.ts";
import { tenants } from "./schema.ts";
import { startTestDatabase, type TestDatabase, waitFor, waitForTenantJobs } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

let testDb: TestDatabase;
let db: Database;
let runner: JobRunner;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    pollingIntervalSeconds: 0.5,
    onError: (error) => {
      throw error;
    },
  });
  await runner.start();
});

afterAll(async () => {
  await runner?.stop();
  await db?.close();
  await testDb?.stop();
});

async function workspace() {
  const id = uuidv7();
  await db.withTenant(id, (tx) => tx.insert(tenants).values({ id, name: "untouched" }));
  return id;
}

async function nameOf(id: string) {
  const [row] = await db.withTenant(id, (tx) => tx.select().from(tenants));
  return row?.name;
}

it("cannot prove no effect while a real job is queued or its worker is held at a barrier", async () => {
  const tenantId = await workspace();
  const job = defineTenantJob("wait-held", {});
  await runner.ensureQueue(job);
  const id = await db.withTenant(tenantId, (tx) => enqueue(tx, job, { tenantId }));
  expect(await nameOf(tenantId)).toBe("untouched");
  await expect(waitForTenantJobs(testDb, tenantId, { timeoutMs: 100 })).rejects.toThrow(
    new RegExp(`tenant ${tenantId}.*${id}.*wait-held.*created`),
  );

  const claimed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await runner.work(job, {
    transaction: async (_payload, tx) => {
      claimed.resolve();
      await release.promise;
      await tx.update(tenants).set({ name: "processed" }).where(eq(tenants.id, tenantId));
    },
    onGiveUp: async () => {},
  });
  try {
    await claimed.promise;
    expect(await nameOf(tenantId)).toBe("untouched");
    await expect(waitForTenantJobs(testDb, tenantId, { timeoutMs: 100 })).rejects.toThrow(
      new RegExp(`${id}.*wait-held.*active`),
    );
  } finally {
    release.resolve();
  }
  const result = await waitForTenantJobs(testDb, tenantId);
  expect(result.terminal).toMatchObject([{ id, state: "completed" }]);
  expect(result.deferred).toEqual([]);
  expect(await nameOf(tenantId)).toBe("processed");
});

it("waits through retry backoff and reports failed jobs after give-up commits", async () => {
  const tenantId = await workspace();
  const job = defineTenantJob("wait-retry", {});
  await runner.ensureQueue(job, { limit: 1, delaySeconds: 1, backoff: false });
  const attempted = Promise.withResolvers<void>();
  await runner.work(job, {
    transaction: async () => {
      attempted.resolve();
      throw new Error("retry proof");
    },
    onGiveUp: async (_payload, tx) => {
      await tx.update(tenants).set({ name: "gave up" }).where(eq(tenants.id, tenantId));
    },
  });
  const id = await db.withTenant(tenantId, (tx) => enqueue(tx, job, { tenantId }));
  await attempted.promise;
  const result = await waitForTenantJobs(testDb, tenantId);
  expect(result.terminal).toMatchObject([{ id, state: "failed", retryCount: 1 }]);
  expect(result.deferred).toEqual([]);
  expect(await nameOf(tenantId)).toBe("gave up");
});

it("returns scheduled jobs without running them and excludes other tenants and queues", async () => {
  const tenantId = await workspace();
  const other = await workspace();
  const daily = defineTenantJob("wait-daily", {});
  const unworked = defineTenantJob("wait-unworked", {});
  await runner.ensureQueue(daily);
  await runner.ensureQueue(unworked);
  const tomorrow = new Date(Date.now() + 86_400_000);
  const id = await db.withTenant(tenantId, (tx) =>
    enqueue(tx, daily, { tenantId }, { startAfter: tomorrow }),
  );
  await db.withTenant(other, (tx) => enqueue(tx, daily, { tenantId: other }));
  await db.withTenant(tenantId, (tx) => enqueue(tx, unworked, { tenantId }));
  const options = { queues: [daily.queue] };
  const first = await waitForTenantJobs(testDb, tenantId, options);
  expect(first.terminal).toEqual([]);
  expect(first.deferred).toMatchObject([{ id, state: "created", startAfter: tomorrow }]);
  expect(await waitForTenantJobs(testDb, tenantId, options)).toEqual(first);
  await expect(waitForTenantJobs(testDb, tenantId, { timeoutMs: 100 })).rejects.toThrow(
    /wait-unworked/,
  );
});

it("waits for due follow-on jobs committed by a worker", async () => {
  const tenantId = await workspace();
  const parent = defineTenantJob("wait-parent", {});
  const child = defineTenantJob("wait-child", {});
  await runner.work(child, {
    transaction: async (_payload, tx) => {
      await tx.update(tenants).set({ name: "child done" }).where(eq(tenants.id, tenantId));
    },
    onGiveUp: async () => {},
  });
  await runner.work(parent, {
    transaction: async (payload, tx) => {
      await enqueue(tx, child, payload);
    },
    onGiveUp: async () => {},
  });
  await db.withTenant(tenantId, (tx) => enqueue(tx, parent, { tenantId }));
  const result = await waitForTenantJobs(testDb, tenantId);
  expect(result.terminal.map(({ queue, state }) => [queue, state]).sort()).toEqual([
    [child.queue, "completed"],
    [parent.queue, "completed"],
  ]);
  expect(await nameOf(tenantId)).toBe("child done");
});

it("polls the supplied observation and reports its condition on timeout", async () => {
  let observations = 0;
  expect(
    await waitFor("third observation", async () => (++observations === 3 ? "ready" : undefined)),
  ).toBe("ready");
  await expect(
    waitFor("missing observation", async () => undefined, { timeoutMs: 1 }),
  ).rejects.toThrow(/missing observation: condition is still undefined/);
});
