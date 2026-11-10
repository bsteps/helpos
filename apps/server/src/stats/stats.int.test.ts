import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  type JobRunner,
} from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { buildDemoData, seedToken } from "../seed/demo-data.ts";
import { seedDemoData } from "../seed/seed.ts";
import { composeServices, defaultConfig } from "../services.ts";

// Draft stats against real Postgres and RLS, on the demo data: each workspace counts only its
// own drafts and its own `draft.edited` events.

const range = "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z";
let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let jobs: JobRunner;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  jobs = createJobRunner({ jobsUrl: testDb.jobsUrl, db, onError: () => {} });
  await jobs.start();
  const seeded = await seedDemoData({ db, auth, jobs, config: defaultConfig });
  if (!seeded.ok) throw new Error(seeded.reason);
  app = createApp(
    composeServices({
      db,
      files: createMemoryFileStore(),
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    }),
  );
});

afterAll(async () => {
  await jobs?.stop();
  await db?.close();
  await auth?.close();
  await testDb?.stop();
});

const stats = (token: string, query = range) =>
  app.request(`/v1/stats/drafts?${query}`, { headers: { authorization: `Bearer ${token}` } });

describe("GET /v1/stats/drafts", () => {
  it("counts each workspace's own drafts, never another's", async () => {
    const northwind = await stats(seedToken("northwind:stats-reader"));
    expect(northwind.status).toBe(200);
    expect(await northwind.json()).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      approvedUnchanged: 2,
      approvedEdited: 1,
      discarded: 1,
      pending: 3,
      unchangedRate: 2 / 3,
    });
    const lumen = await stats(seedToken("lumen:stats-reader"));
    expect(await lumen.json()).toMatchObject({
      approvedUnchanged: 1,
      approvedEdited: 0,
      discarded: 0,
      pending: 3,
      unchangedRate: 1,
    });
  });

  it("matches the demo data's own count of each workspace's drafts", async () => {
    for (const t of buildDemoData().tenants) {
      const body = (await (await stats(seedToken(`${t.key}:stats-reader`))).json()) as Record<
        string,
        number
      >;
      const total =
        (body.approvedUnchanged ?? 0) +
        (body.approvedEdited ?? 0) +
        (body.discarded ?? 0) +
        (body.pending ?? 0);
      expect(total).toBe(t.drafts.length);
    }
  });

  it("counts nothing outside the range", async () => {
    const res = await stats(
      seedToken("northwind:stats-reader"),
      "from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z",
    );
    expect(await res.json()).toMatchObject({
      approvedUnchanged: 0,
      approvedEdited: 0,
      discarded: 0,
      pending: 0,
      unchangedRate: null,
    });
  });

  it("needs stats:read", async () => {
    expect((await stats(seedToken("northwind:triage-bot"))).status).toBe(403);
    expect((await stats("hos_not-a-real-token")).status).toBe(401);
  });

  it("refuses an empty or overlong range", async () => {
    const token = seedToken("northwind:stats-reader");
    expect((await stats(token, "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z")).status).toBe(
      400,
    );
    expect((await stats(token, "from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")).status).toBe(
      400,
    );
    expect((await stats(token, "from=yesterday")).status).toBe(400);
  });
});
