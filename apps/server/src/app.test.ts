import { createDatabase, type Database } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";

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
    const res = await createApp({ db, logger: { error: vi.fn() } }).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const down = createDatabase("postgres://nobody:nothing@127.0.0.1:1/none");
    try {
      const logger = { error: vi.fn() };
      const res = await createApp({ db: down, logger }).request("/health");
      expect(res.status).toBe(503);
      // No error details leak into the response, but they are logged.
      expect(await res.json()).toEqual({ status: "error", database: "unreachable" });
      expect(logger.error).toHaveBeenCalledOnce();
    } finally {
      await down.close();
    }
  });
});
