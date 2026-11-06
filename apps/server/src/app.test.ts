import { createDatabase, type Database } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";

const files = createMemoryFileStore();
const logger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });

describe("GET /health", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = createDatabase(testDb.appUrl);
  });

  afterAll(async () => {
    await db?.close();
    await testDb?.container.stop();
  });

  it("returns 200 OK when the database is reachable", async () => {
    const res = await createApp({ db, files, logger: logger(), inboundSecret: undefined }).request(
      "/health",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const down = createDatabase("postgres://nobody:nothing@127.0.0.1:1/none");
    try {
      const log = logger();
      const res = await createApp({
        db: down,
        files,
        logger: log,
        inboundSecret: undefined,
      }).request("/health");
      expect(res.status).toBe(503);
      // No error details leak into the response, but they are logged.
      expect(await res.json()).toEqual({ status: "error", database: "unreachable" });
      expect(log.error).toHaveBeenCalledOnce();
    } finally {
      await down.close();
    }
  });
});
