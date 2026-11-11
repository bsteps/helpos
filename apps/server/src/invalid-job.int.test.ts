import { createDatabase, defineTenantJob, enqueue, uuidv7 } from "@helpos/db";
import { startTestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createLogger } from "./logger.ts";
import { composeServer } from "./server.ts";

it("logs the queue and job ID after a stored payload becomes invalid", async () => {
  const testDb = await startTestDatabase();
  const db = createDatabase(testDb.appUrl);
  const lines: string[] = [];
  const logger = createLogger({ level: "error" }, { write: (line: string) => lines.push(line) });
  const server = composeServer({
    db,
    jobsUrl: testDb.jobsUrl,
    files: createMemoryFileStore(),
    logger,
    pollingIntervalSeconds: 0.5,
  });
  const oldJob = defineTenantJob("test-schema-change", {});
  const currentJob = defineTenantJob(oldJob.queue, { ticketId: z.uuid() });
  const handler = vi.fn();
  const onGiveUp = vi.fn();
  try {
    await server.runner.start();
    await server.runner.ensureQueue(currentJob, { limit: 1, delaySeconds: 1, backoff: false });
    const tenantId = uuidv7();
    const jobId = await db.withTenant(tenantId, (tx) => enqueue(tx, oldJob, { tenantId }));
    await server.runner.work(currentJob, { transaction: handler, onGiveUp });
    await expect.poll(() => lines.length, { timeout: 20_000 }).toBe(1);
    expect(JSON.parse(lines.join(""))).toMatchObject({
      level: 50,
      queue: currentJob.queue,
      jobId,
      err: { name: "Error" },
      msg: "job runner error",
    });
    expect(lines.join("")).not.toContain(tenantId);
    expect(lines.join("")).not.toContain("ticketId");
    expect(lines.join("")).not.toContain("Invalid stored job payload");
    expect(handler).not.toHaveBeenCalled();
    expect(onGiveUp).not.toHaveBeenCalled();
  } finally {
    await server.stopWorker();
    await db.close();
    await testDb.stop();
  }
});
