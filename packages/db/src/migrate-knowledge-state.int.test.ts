import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { knowledgeFailureCodes, knowledgeSourceStateSchema } from "./knowledge-state.ts";
import { runMigrations } from "./migrate.ts";
import { containerHost } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

let container: StartedPostgreSqlContainer;
let ownerUrl: string;
let legacyFolder: string;
let owner: postgres.Sql;
const tenant = uuidv7();
const otherTenant = uuidv7();
beforeEach(async () => {
  legacyFolder = await mkdtemp(join(tmpdir(), "helpos-214-migration-"));
  await cp(new URL("../migrations/", import.meta.url), legacyFolder, { recursive: true });
  const journalPath = join(legacyFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 21);
  await writeFile(journalPath, JSON.stringify(journal));
  container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withCopyFilesToContainer([
      {
        source: fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url)),
        target: "/docker-entrypoint-initdb.d/init.sql",
      },
    ])
    .start();
  ownerUrl = `postgres://helpos_owner:helpos_owner@${containerHost(container)}:${container.getPort()}/helpos`;
  owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
  await migrate(drizzle(owner), { migrationsFolder: legacyFolder });
  for (const id of [tenant, otherTenant]) {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${id}, true)`;
      await tx`insert into tenants (id, name) values (${id}, 'migration fixture')`;
    });
  }
});

afterEach(async () => {
  await owner?.end({ timeout: 5 });
  await container?.stop();
  if (legacyFolder) await rm(legacyFolder, { recursive: true, force: true });
});

async function applyMigration() {
  await runMigrations(ownerUrl);
}

async function insertLegacy(tenantId: string, status: string, error: string | null) {
  const id = uuidv7();
  await owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`insert into knowledge_sources
      (id, tenant_id, slug, kind, title, content, status, error, chunk_count, ingest_requests,
       embedding_model, managed_by, source_path, source_commit, ingested_at)
      values (${id}, ${tenantId}, ${id}, 'markdown', 'Retained title', 'Retained content',
        ${status}, ${error}, 1, 7, 'test/model', 'git', 'knowledge/test.md', 'abc123', '2026-01-01')`;
    await tx`insert into knowledge_chunks
      (id, tenant_id, source_id, position, content, embedding, embedding_model)
      values (${uuidv7()}, ${tenantId}, ${id}, 0, 'Retained passage',
        ${JSON.stringify(Array.from({ length: 1024 }, () => 0.1))}::vector, 'test/model')`;
  });
  return id;
}

async function sources(tenantId: string) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return tx`select * from knowledge_sources order by id`;
  });
}

describe("migration 0022 from the current main schema", () => {
  it("preserves source data and passages across tenants while translating every state", async () => {
    const cases = [
      { status: "pending", error: null, state: { status: "pending" }, retryCount: 0 },
      { status: "ready", error: null, state: { status: "ready" }, retryCount: 0 },
      ...knowledgeFailureCodes.map((code) => ({
        status: "failed",
        error: code,
        state: { status: "failed", reason: { code } },
        retryCount: 0,
      })),
      {
        status: "failed",
        error: "http_599",
        state: { status: "failed", reason: { code: "http_error", status: 599 } },
        retryCount: 0,
      },
      ...[408, 425, 429, 500, 502, 503, 504].map((status) => ({
        status: "pending",
        error: `http_${status}`,
        state: { status: "waiting", reason: { code: "http_error", status } },
        retryCount: 1,
      })),
      ...["timeout", "network"].map((code) => ({
        status: "pending",
        error: code,
        state: { status: "waiting", reason: { code } },
        retryCount: 1,
      })),
      {
        status: "pending",
        error: "embedding_unavailable",
        state: { status: "waiting", reason: { code: "embedding_unavailable" } },
        retryCount: 1,
      },
      {
        status: "pending",
        error: "daily_budget_reached",
        state: { status: "waiting", reason: { code: "daily_budget_reached" } },
        retryCount: 0,
      },
    ];
    for (const id of [tenant, otherTenant]) {
      for (const entry of cases) await insertLegacy(id, entry.status, entry.error);
    }
    const before = new Map(
      await Promise.all([tenant, otherTenant].map(async (id) => [id, await sources(id)] as const)),
    );
    const started = Date.now();
    await applyMigration();
    for (const id of [tenant, otherTenant]) {
      const rows = await sources(id);
      expect(rows).toHaveLength(cases.length);
      for (const [index, row] of rows.entries()) {
        const original = before.get(id)?.[index];
        const entry = cases[index];
        if (!original || !entry) throw new Error("missing migration fixture");
        const { status: _status, error: _error, ...retained } = original;
        const { state, retry_count, ...actual } = row;
        expect(actual).toEqual(retained);
        expect(state).toMatchObject(entry.state);
        expect(retry_count).toBe(entry.retryCount);
        const parsed = knowledgeSourceStateSchema.parse(state);
        if (parsed.status === "waiting") {
          expect(Date.parse(parsed.retryAt)).toBeGreaterThanOrEqual(started - 1000);
          expect(Date.parse(parsed.retryAt)).toBeLessThanOrEqual(Date.now());
        }
      }
      await owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${id}, true)`;
        const chunks = await tx`select content, embedding_model from knowledge_chunks`;
        expect(chunks).toHaveLength(cases.length);
        expect(
          chunks.every(
            (row) => row.content === "Retained passage" && row.embedding_model === "test/model",
          ),
        ).toBe(true);
      });
    }
    const [table] =
      await owner`select relforcerowsecurity from pg_class where relname = 'knowledge_sources'`;
    expect(table?.relforcerowsecurity).toBe(true);
  });

  it("aborts atomically on unknown old errors instead of silently discarding them", async () => {
    await insertLegacy(tenant, "failed", "unrecognized_failure");
    const before = await sources(tenant);
    await expect(applyMigration()).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await sources(tenant)).toEqual(before);
    const [table] =
      await owner`select relforcerowsecurity from pg_class where relname = 'knowledge_sources'`;
    expect(table?.relforcerowsecurity).toBe(true);
  });

  it("rejects malformed state and negative retry counts at the database boundary", async () => {
    const id = await insertLegacy(tenant, "ready", null);
    await applyMigration();
    const invalid = [
      null,
      {},
      { status: "unknown" },
      { status: "ready", reason: { code: "no_text" } },
      { status: "failed" },
      { status: "failed", reason: null },
      { status: "failed", reason: { code: "made_up" } },
      { status: "failed", reason: { code: "http_error", status: "503" } },
      { status: "failed", reason: { code: "http_error", status: 99 } },
      { status: "waiting", reason: { code: "no_text" }, retryAt: "2026-01-01T00:00:00Z" },
      { status: "waiting", reason: { code: "network" } },
      {
        status: "waiting",
        reason: { code: "http_error", status: 404 },
        retryAt: "2026-01-01T00:00:00Z",
      },
      { status: "waiting", reason: { code: "network" }, retryAt: "tomorrow" },
      { status: "waiting", reason: { code: "network" }, retryAt: "2026-02-30T00:00:00Z" },
    ];
    for (const state of invalid) {
      await expect(
        owner.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${tenant}, true)`;
          await tx`update knowledge_sources set state = ${JSON.stringify(state)}::jsonb where id = ${id}`;
        }),
        JSON.stringify(state),
      ).rejects.toBeDefined();
    }
    await expect(
      owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenant}, true)`;
        await tx`update knowledge_sources set retry_count = -1 where id = ${id}`;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
