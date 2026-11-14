import { createDatabase, type Database } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";
import { ensureJobQueues } from "./jobs.ts";
import { composeServer } from "./server.ts";
import { composeServices } from "./services.ts";

const files = createMemoryFileStore();
const logger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

describe("liveness and readiness", () => {
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

  it("returns 200 OK when the database is reachable", async () => {
    const res = await createApp(composeServices({ db, files, logger: logger() })).request(
      "/health",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("keeps liveness available when the database is unreachable", async () => {
    const down = createDatabase("postgres://nobody:nothing@127.0.0.1:1/none");
    try {
      const log = logger();
      const res = await createApp(composeServices({ db: down, files, logger: log })).request(
        "/health",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      await down.close();
    }
  });

  it("requires the real database and every registered queue for readiness", async () => {
    const server = composeServer({ db, jobsUrl: testDb.jobsUrl, files, logger: logger() });
    await server.runner.start();
    try {
      expect((await server.app().request("/readyz")).status).toBe(503);
      await ensureJobQueues(server.runner);
      const ready = await server.app().request("/readyz");
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok" });
      const down = createDatabase("postgres://nobody:nothing@127.0.0.1:1/none");
      try {
        const res = await createApp({ ...server.services, db: down }).request("/readyz");
        expect(res.status).toBe(503);
        const body = await res.text();
        expect(JSON.parse(body)).toMatchObject({ error: "not_ready", status: 503 });
        expect(body).not.toContain("postgres");
      } finally {
        await down.close();
      }
    } finally {
      await server.runner.stop();
    }
    expect((await server.app().request("/readyz")).status).toBe(503);
    expect((await server.app().request("/health")).status).toBe(200);
  });
});
