import { and, createDatabase, type Database, desc, eq, lt, or, schema, uuidv7 } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cursorPage, paginationQuery } from "./pagination.ts";

let testDb: TestDatabase;
let db: Database;
const tenantId = uuidv7();
const time = new Date("2026-11-12T00:00:00Z");
beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  await db.withTenant(tenantId, async (tx) => {
    await tx.insert(schema.tenants).values({ id: tenantId, name: "pagination" });
    await tx.insert(schema.customers).values(
      Array.from({ length: 7 }, (_, i) => ({
        tenantId,
        email: `page-${i}@example.test`,
        createdAt: time,
      })),
    );
  });
});
afterAll(async () => {
  await db?.close();
  await testDb?.stop();
});

describe("cursor pagination helper", () => {
  it("walks real rows without gaps or duplicates when timestamps tie", async () => {
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const query = paginationQuery.parse({ limit: "3", cursor });
      const t = schema.customers;
      const position = query.cursor;
      const rows = await db.withTenant(tenantId, (tx) =>
        tx
          .select()
          .from(t)
          .where(
            position
              ? or(
                  lt(t.createdAt, new Date(position.createdAt)),
                  and(eq(t.createdAt, new Date(position.createdAt)), lt(t.id, position.id)),
                )
              : undefined,
          )
          .orderBy(desc(t.createdAt), desc(t.id))
          .limit(query.limit + 1),
      );
      const page = cursorPage(rows, query.limit);
      expect(page.items.length).toBeLessThanOrEqual(3);
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toEqual([...ids].sort().reverse());
  });

  it("validates limit and cursor at the boundary", () => {
    expect(paginationQuery.parse({})).toEqual({ limit: 50 });
    for (const limit of ["0", "101", "abc", "1.5"])
      expect(paginationQuery.safeParse({ limit }).success).toBe(false);
    for (const cursor of [
      "%invalid",
      "e30",
      Buffer.from(JSON.stringify({ id: "bad", createdAt: time.toISOString() })).toString(
        "base64url",
      ),
      "a".repeat(513),
    ])
      expect(paginationQuery.safeParse({ cursor }).success).toBe(false);
    expect(cursorPage([], 3)).toEqual({ items: [], nextCursor: null });
    expect(cursorPage([{ id: uuidv7(), createdAt: time }], 3).nextCursor).toBeNull();
  });
});
