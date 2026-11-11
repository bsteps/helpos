import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { createDatabase, type Database, type TenantTx } from "./client.ts";
import {
  hasSearchableKnowledge,
  type KnowledgeQuery,
  normalizeKnowledgeUrl,
  searchKnowledge,
} from "./knowledge.ts";
import {
  type KnowledgeVisibility,
  knowledgeEmbeddingDimensions,
  knowledgeSources,
  tenants,
} from "./schema.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";
import { uuidv7 } from "./uuid.ts";

// Vector search under row-level security. The leak cases live in leak.test.ts.

let testDb: TestDatabase;
let db: Database;
const large = uuidv7();
const small = uuidv7();

const model = "test/model";

/** Unit vector along axis 0, the query in every test here. */
const query = (() => {
  const v = new Array<number>(knowledgeEmbeddingDimensions).fill(0);
  v[0] = 1;
  return v;
})();

/**
 * Adds `count` chunks whose vectors are `lean` along axis 0 plus noise along `axis`. Built in
 * SQL, so a thousand 1024-dimension rows don't travel over the wire.
 */
async function seedChunks(
  tx: TenantTx,
  tenantId: string,
  count: number,
  lean: number,
  axis: number,
  visibility: KnowledgeVisibility = "internal",
): Promise<string> {
  const [source] = await tx
    .insert(knowledgeSources)
    .values({
      tenantId,
      slug: `s-${uuidv7()}`,
      kind: "markdown",
      title: visibility === "public" ? "Public doc" : "Doc",
      content: "x",
      visibility,
    })
    .returning({ id: knowledgeSources.id });
  if (!source) throw new Error("seed: no source");
  await tx.execute(sql`
    insert into knowledge_chunks
      (id, tenant_id, source_id, position, content, embedding_model, embedding)
    select gen_random_uuid(), ${tenantId}, ${source.id}, g, 'chunk ' || g, ${model},
      ('[' || array_to_string(array(
        select case when i = 1 then ${lean}::float8
                    when i = ${axis + 1} then 1
                    else random() * 0.01 + g * 0 end
        from generate_series(1, ${knowledgeEmbeddingDimensions}) i), ',') || ']')::vector
    from generate_series(1, ${count}) g`);
  return source.id;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  // The large tenant's chunks are all much closer to the query than the small tenant's, so an
  // index scan that stops after its first candidates would find only the large tenant's rows.
  await db.withTenant(large, async (tx) => {
    await tx.insert(tenants).values({ id: large, name: "large" });
    await seedChunks(tx, large, 1_000, 10, 5);
    // Two public passages, far from the query: every internal one is a better match.
    await seedChunks(tx, large, 2, 0.2, 7, "public");
  });
  await db.withTenant(small, async (tx) => {
    await tx.insert(tenants).values({ id: small, name: "small" });
    await seedChunks(tx, small, 3, 0.2, 9);
  });
});

afterAll(async () => {
  await db?.close();
  await testDb?.stop();
});

/** Makes the planner use the HNSW index, the path where filtering after the search hurts. */
async function forceIndex(tx: TenantTx): Promise<void> {
  await tx.execute(sql`set local enable_seqscan = off`);
  await tx.execute(sql`set local enable_bitmapscan = off`);
  await tx.execute(sql`set local enable_sort = off`);
}

describe("searchKnowledge", () => {
  it("requires an approver or customer audience by type", () => {
    expectTypeOf<KnowledgeQuery>().toExtend<{ audience: "approver" | "customer" }>();
    expectTypeOf<Omit<KnowledgeQuery, "audience">>().not.toExtend<KnowledgeQuery>();
    expectTypeOf<
      Omit<KnowledgeQuery, "audience"> & { audience: "internal" }
    >().not.toExtend<KnowledgeQuery>();
  });

  it.each([undefined, "internal", null])("rejects an untyped audience %s", async (audience) => {
    const input: KnowledgeQuery = {
      tenantId: small,
      embedding: query,
      embeddingModel: model,
      limit: 5,
      audience: "customer",
    };
    Reflect.set(input, "audience", audience);
    await expect(db.withTenant(small, (tx) => searchKnowledge(tx, input))).rejects.toThrow();
    const { tenantId, embeddingModel } = input;
    await expect(
      db.withTenant(small, (tx) =>
        hasSearchableKnowledge(tx, { tenantId, embeddingModel, audience: input.audience }),
      ),
    ).rejects.toThrow();
  });

  it("keeps customer results public and both audiences inside their tenant", async () => {
    const owners = [uuidv7(), uuidv7()];
    const seeded = await Promise.all(
      owners.map((tenantId) =>
        db.withTenant(tenantId, async (tx) => {
          await tx.insert(tenants).values({ id: tenantId, name: tenantId });
          const internalId = await seedChunks(tx, tenantId, 1, 10, 3);
          const publicId = await seedChunks(tx, tenantId, 2, 0.2, 4, "public");
          return { tenantId, internalId, publicId };
        }),
      ),
    );
    for (const { tenantId, internalId, publicId } of seeded) {
      const base = { tenantId, embedding: query, embeddingModel: model, limit: 20 };
      const customer = await db.withTenant(tenantId, (tx) =>
        searchKnowledge(tx, { ...base, audience: "customer" }),
      );
      expect(customer.map((h) => [h.sourceId, h.visibility])).toEqual([
        [publicId, "public"],
        [publicId, "public"],
      ]);
      const approver = await db.withTenant(tenantId, (tx) =>
        searchKnowledge(tx, { ...base, audience: "approver" }),
      );
      expect(approver.map((h) => h.sourceId)).toEqual([internalId, publicId, publicId]);
      for (const outsider of seeded.filter((s) => s.tenantId !== tenantId)) {
        for (const audience of ["customer", "approver"] as const) {
          expect(
            await db.withTenant(tenantId, (tx) =>
              searchKnowledge(tx, { ...base, tenantId: outsider.tenantId, audience }),
            ),
          ).toEqual([]);
          expect(
            await db.withTenant(tenantId, (tx) =>
              hasSearchableKnowledge(tx, {
                tenantId: outsider.tenantId,
                embeddingModel: model,
                audience,
              }),
            ),
          ).toBe(false);
        }
      }
    }
  });

  it("sets hnsw.iterative_scan for the rest of its transaction only", async () => {
    const inside = await db.withTenant(small, async (tx) => {
      await searchKnowledge(tx, {
        tenantId: small,
        embedding: query,
        embeddingModel: model,
        audience: "approver",
        limit: 1,
      });
      return tx.execute<{ v: string }>(sql`select current_setting('hnsw.iterative_scan') as v`);
    });
    expect(inside[0]?.v).toBe("relaxed_order");
    const after = await db.withTenant(small, (tx) =>
      tx.execute<{ v: string | null }>(
        sql`select current_setting('hnsw.iterative_scan', true) as v`,
      ),
    );
    expect(after[0]?.v ?? "off").not.toBe("relaxed_order");
  });

  it("returns the nearest chunks first, with their source", async () => {
    const hits = await db.withTenant(large, (tx) =>
      searchKnowledge(tx, {
        tenantId: large,
        embedding: query,
        embeddingModel: model,
        audience: "approver",
        limit: 5,
      }),
    );
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.title === "Doc" && h.visibility === "internal")).toBe(true);
    const distances = hits.map((h) => h.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("finds the public passages behind a thousand better internal ones, on the index", async () => {
    const hits = await db.withTenant(large, async (tx) => {
      await forceIndex(tx);
      return searchKnowledge(tx, {
        tenantId: large,
        embedding: query,
        embeddingModel: model,
        audience: "customer",
        limit: 5,
      });
    });
    expect(hits.map((h) => [h.title, h.visibility])).toEqual([
      ["Public doc", "public"],
      ["Public doc", "public"],
    ]);
  });

  it("never compares vectors from another embedding model", async () => {
    const hits = await db.withTenant(large, (tx) =>
      searchKnowledge(tx, {
        tenantId: large,
        embedding: query,
        embeddingModel: "other",
        audience: "approver",
        limit: 5,
      }),
    );
    expect(hits).toEqual([]);
  });

  it("rejects a vector of the wrong size and a silly limit", async () => {
    await expect(
      db.withTenant(small, (tx) =>
        searchKnowledge(tx, {
          tenantId: small,
          embedding: [1, 0],
          embeddingModel: model,
          audience: "approver",
          limit: 5,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.withTenant(small, (tx) =>
        searchKnowledge(tx, {
          tenantId: small,
          embedding: query,
          embeddingModel: model,
          audience: "approver",
          limit: 1_000,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("vector recall for a small tenant among large ones", () => {
  it("the planner really uses the HNSW index in this test", async () => {
    const plan = await db.withTenant(small, async (tx) => {
      await forceIndex(tx);
      return tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select id from knowledge_chunks where tenant_id = ${small}
        order by embedding <=> ${JSON.stringify(query)}::vector limit 5`);
    });
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain("knowledge_chunks_embedding");
  });

  it("without iterative scan, the shared index finds none of the small tenant's chunks", async () => {
    // The failure iterative scan prevents, shown so the next test is known to prove something.
    const rows = await db.withTenant(small, async (tx) => {
      await forceIndex(tx);
      await tx.execute(sql`set local hnsw.iterative_scan = off`);
      return tx.execute(sql`
        select id from knowledge_chunks where tenant_id = ${small}
        order by embedding <=> ${JSON.stringify(query)}::vector limit 5`);
    });
    expect(rows.length).toBeLessThan(3);
  });

  it("searchKnowledge finds all of the small tenant's chunks on the same index", async () => {
    const hits = await db.withTenant(small, async (tx) => {
      await forceIndex(tx);
      return searchKnowledge(tx, {
        tenantId: small,
        embedding: query,
        embeddingModel: model,
        audience: "approver",
        limit: 5,
      });
    });
    expect(hits).toHaveLength(3);
  });
});

describe("normalizeKnowledgeUrl", () => {
  it("drops what doesn't change the page, keeps what may", () => {
    expect(normalizeKnowledgeUrl("HTTPS://Docs.Example.test:443/A?b=C#top")).toBe(
      "https://docs.example.test/A?b=C",
    );
    expect(normalizeKnowledgeUrl("http://x.test:80")).toBe("http://x.test/");
    expect(normalizeKnowledgeUrl("http://x.test:8080/")).toBe("http://x.test:8080/");
  });
});
