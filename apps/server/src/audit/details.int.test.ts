import { createDatabase, type Database, eq, schema, uuidv7 } from "@helpos/db";
import { startTestDatabase, type TestDatabase } from "@helpos/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AuditAction, auditTrail, recordAudit } from "./audit.ts";
import { auditDetails, hashBody } from "./details.ts";

let testDb: TestDatabase;
let db: Database;
const tenantId = uuidv7();
const target = { type: "draft", id: uuidv7() } as const;
const context = {
  tenantId,
  actor: { type: "user", id: uuidv7() },
  requestId: "audit-inputs",
} as const;

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  await db.withTenant(tenantId, (tx) =>
    tx.insert(schema.tenants).values({ id: tenantId, name: "Audit inputs" }),
  );
});

afterAll(async () => {
  await db?.close();
  await testDb?.stop();
});

it("stores hashes and attribution in the same row without copying body text", async () => {
  const details = {
    oldBodyHash: hashBody("Old synthetic body"),
    newBodyHash: hashBody("New body 🧪"),
  };
  await db.withTenant(tenantId, (tx) =>
    recordAudit(tx, { ...context, action: "draft.edited", target, details }),
  );
  const rows = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.targetId, target.id)),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    tenantId,
    actorType: "user",
    actorId: context.actor.id,
    requestId: context.requestId,
    action: "draft.edited",
    targetType: "draft",
    targetId: target.id,
    details,
  });
  expect(JSON.stringify(rows)).not.toContain("synthetic body");
  expect(JSON.stringify(rows)).not.toContain("New body");
});

it("rolls back the action and records no audit coverage when details are invalid", async () => {
  const trail = { recorded: new Set<"draft.edited">(), nothingChanged: false };
  await expect(
    auditTrail.run(trail, () =>
      db.withTenant(tenantId, async (tx) => {
        await tx.update(schema.tenants).set({ name: "Must roll back" });
        await recordAudit(tx, {
          ...context,
          action: "draft.edited",
          target,
          details: { oldBodyHash: "invalid", newBodyHash: hashBody("new") },
        });
      }),
    ),
  ).rejects.toThrow();
  const [tenant] = await db.withTenant(tenantId, (tx) => tx.select().from(schema.tenants));
  expect(tenant?.name).toBe("Audit inputs");
  expect(trail.recorded.size).toBe(0);
});

it("refuses UPDATE of details and DELETE for the app role", async () => {
  const id = uuidv7();
  await db.withTenant(tenantId, (tx) =>
    tx.insert(schema.auditEvents).values({
      id,
      tenantId,
      actorType: "system",
      actorId: "legacy-fixture",
      action: "draft.edited",
      targetType: "draft",
      targetId: target.id,
    }),
  );
  await expect(
    db.withTenant(tenantId, (tx) =>
      tx
        .update(schema.auditEvents)
        .set({ details: { forged: true } })
        .where(eq(schema.auditEvents.id, id)),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  await expect(
    db.withTenant(tenantId, (tx) =>
      tx.delete(schema.auditEvents).where(eq(schema.auditEvents.id, id)),
    ),
  ).rejects.toMatchObject({ cause: { code: "42501" } });
  const [legacy] = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, id)),
  );
  expect(legacy?.details).toBeNull();
});

it.each(Object.entries(auditDetails))(
  "rejects unexpected customer text for %s",
  (_action, validator) => {
    expect(validator.safeParse({ body: "Do not persist customer text" }).success).toBe(false);
  },
);

it("rejects missing, mismatched and fabricated draft inputs", () => {
  expect(auditDetails["draft.edited"].safeParse({}).success).toBe(false);
  expect(auditDetails["draft.approved"].safeParse({ bodyHash: hashBody("body") }).success).toBe(
    false,
  );
  expect(auditDetails["draft.discarded"].safeParse({ reason: "superseded" }).success).toBe(false);
  expect(
    auditDetails["draft.discarded"].safeParse({ reason: "manual", newerMessageId: uuidv7() })
      .success,
  ).toBe(false);
  expect(
    auditDetails["draft.discarded"].safeParse({ reason: "superseded", newerMessageId: "unknown" })
      .success,
  ).toBe(false);
});

it.each(
  Object.keys(auditDetails).filter((action): action is AuditAction => action in auditDetails),
)("rolls back invalid %s details through the storage adapter", async (action) => {
  const requestId = uuidv7();
  await expect(
    db.withTenant(tenantId, async (tx) => {
      await tx.update(schema.tenants).set({ name: requestId });
      await recordAudit(tx, {
        ...context,
        requestId,
        action,
        target,
        details: { oldBodyHash: "not-a-hash", newBodyHash: "not-a-hash" },
      });
    }),
  ).rejects.toThrow();
  const [tenant] = await db.withTenant(tenantId, (tx) => tx.select().from(schema.tenants));
  expect(tenant?.name).toBe("Audit inputs");
  const rows = await db.withTenant(tenantId, (tx) =>
    tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.requestId, requestId)),
  );
  expect(rows).toEqual([]);
});
