import { createDatabase, type Database, schema, sql } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  draftWhere,
  isApprovedDraft,
  isPendingDraft,
  isSentDraft,
  isUncertainDraft,
} from "./lifecycle.ts";

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

it("preserves live, open, failure and historical approval meanings for every status", async () => {
  const after = new Date("2026-01-01T00:00:00Z");
  for (const status of schema.draftStatuses) {
    expect(isPendingDraft({ status })).toBe(status === "pending");
    expect(isApprovedDraft({ status })).toBe(status === "approved");
    expect(isSentDraft({ status })).toBe(status === "sent");
    expect(isUncertainDraft({ status })).toBe(status === "send_uncertain");
    for (const approvedAt of [
      null,
      "2025-12-31T00:00:00Z",
      after.toISOString(),
      "2026-01-02T00:00:00Z",
    ]) {
      const rows = await db.withTenant("00000000-0000-4000-8000-000000000001", (tx) =>
        tx.execute(sql`
        select ${draftWhere.pending()} as pending,
          ${draftWhere.live()} as live,
          ${draftWhere.sendFailed()} as failed,
          ${draftWhere.sendUncertain()} as uncertain,
          ${draftWhere.wasApproved()} as approved,
          coalesce(${draftWhere.wasApproved(after)}, false) as recent
        from (values (${status}::text, ${approvedAt}::timestamptz)) as drafts(status, approved_at)
      `),
      );
      expect(rows[0]).toEqual({
        pending: status === "pending",
        live: status !== "discarded",
        failed: status === "send_failed",
        uncertain: status === "send_uncertain",
        approved: approvedAt !== null,
        recent: approvedAt !== null && new Date(approvedAt) > after,
      });
    }
  }
});
