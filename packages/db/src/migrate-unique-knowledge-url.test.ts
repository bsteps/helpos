import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeKnowledgeUrl } from "./knowledge.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

// Migration 0011 cleans up URL sources stored before it: it must store them exactly as
// normalizeKnowledgeUrl() would, and keep one source per page, or creating the index fails.

const migration = new URL("../migrations/0011_unique-knowledge-url.sql", import.meta.url);

let testDb: TestDatabase;
let owner: postgres.Sql;

beforeAll(async () => {
  testDb = await startTestDatabase();
  owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 });
  await testDb?.stop();
});

describe("migration 0011", () => {
  it("normalises old URLs and keeps the oldest source per page", async () => {
    const a = uuidv7();
    const b = uuidv7();
    const typed = [
      "HTTPS://Docs.Example.test:443/Refunds?lang=en#top",
      "https://user:Pw@Docs.Example.test/a",
      "http://x.test:80",
      "http://x.test:8080?q=1",
      "https://x.test/keep#",
    ];
    // Back to the state before 0011: no index, URLs as typed, duplicates allowed.
    await owner.unsafe(`drop index knowledge_sources_tenant_url`);
    const insert = (tenantId: string, slug: string, url: string, at: string) =>
      owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
        await tx`insert into knowledge_sources (id, tenant_id, slug, kind, title, url, created_at)
          values (${uuidv7()}, ${tenantId}, ${slug}, 'url', ${slug}, ${url}, ${at})`;
      });
    for (const id of [a, b]) {
      await owner.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${id}, true)`;
        await tx`insert into tenants (id, name) values (${id}, 'w')`;
      });
    }
    for (const [i, url] of typed.entries()) await insert(a, `typed-${i}`, url, "2026-01-02");
    // The same page twice in A, one of them older; and once in B, which must stay.
    await insert(a, "older", "https://docs.example.test/refunds?lang=en", "2026-01-01");
    await insert(a, "newer", "https://DOCS.example.test/refunds?lang=en#x", "2026-01-03");
    await insert(b, "theirs", "https://docs.example.test/refunds?lang=en", "2026-01-03");

    const statements = (await readFile(migration, "utf8")).split("--> statement-breakpoint");
    await owner.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
    });

    const rows = await owner.begin(async (tx) => {
      const out: { tenant_id: string; slug: string; url: string }[] = [];
      for (const id of [a, b]) {
        await tx`select set_config('app.tenant_id', ${id}, true)`;
        out.push(
          ...(await tx<{ tenant_id: string; slug: string; url: string }[]>`
            select tenant_id, slug, url from knowledge_sources order by slug`),
        );
      }
      return out;
    });
    const inA = rows.filter((r) => r.tenant_id === a);
    expect(inA.map((r) => r.slug).sort()).toEqual(
      ["older", ...typed.map((_, i) => `typed-${i}`)].sort(),
    );
    for (const [i, url] of typed.entries()) {
      const row = inA.find((r) => r.slug === `typed-${i}`);
      expect(row?.url).toBe(normalizeKnowledgeUrl(url));
    }
    // "newer" was the same page as "older", so it went.
    expect(inA.find((r) => r.slug === "older")?.url).toBe(
      "https://docs.example.test/refunds?lang=en",
    );
    expect(rows.filter((r) => r.tenant_id === b).map((r) => r.slug)).toEqual(["theirs"]);

    // RLS is forced again, and the index exists.
    const [table] = await owner<{ forced: boolean }[]>`
      select relforcerowsecurity as forced from pg_class where relname = 'knowledge_sources'`;
    expect(table?.forced).toBe(true);
    const [index] =
      await owner`select 1 from pg_indexes where indexname = 'knowledge_sources_tenant_url'`;
    expect(index).toBeDefined();
  });
});
