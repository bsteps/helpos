import { createHash } from "node:crypto";
import {
  type AuthStore,
  createAuthStore,
  createDatabase,
  createJobRunner,
  type Database,
  eq,
  type JobRunner,
  schema,
  uuidv7,
} from "@helpos/db";
import {
  type LeakTenant,
  seedLeakTenant,
  startTestDatabase,
  type TestDatabase,
} from "@helpos/db/testing";
import { createMemoryFileStore } from "@helpos/files";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { nothingToAudit } from "../audit/audit.ts";
import { apiRoute } from "../auth/access.ts";
import { type Principal, scopes } from "../auth/principal.ts";
import { errorSchema, json } from "../http/route-kit.ts";
import { ensureJobQueues } from "../jobs.ts";
import { composeServices } from "../services.ts";
import { generateToken } from "../tokens/token.ts";

let testDb: TestDatabase;
let db: Database;
let auth: AuthStore;
let runner: JobRunner;
let a: LeakTenant;
let b: LeakTenant;
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
const files = createMemoryFileStore();
const clock = { now: () => new Date("2026-11-12T00:00:00Z") };
const services = () => composeServices({ db, files, logger, clock });
const principal = (tenant = a, actorId = tenant.ownerUserId): Principal => ({
  tenantId: tenant.tenantId,
  actor: { type: "user", id: actorId },
  scopes: new Set(scopes),
});
const app = (caller = principal()) => createApp(services(), { authenticate: async () => caller });
const call = (
  instance: ReturnType<typeof app>,
  path: string,
  key: string,
  body?: object,
  method = "POST",
) =>
  instance.request(path, {
    method,
    headers: { "idempotency-key": key, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const rows = (tenant = a) =>
  db.withTenant(tenant.tenantId, (tx) => tx.select().from(schema.httpIdempotency));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = createDatabase(testDb.appUrl);
  auth = createAuthStore(testDb.authUrl);
  a = await seedLeakTenant(db, auth, { tenantId: uuidv7(), tag: "http-a" });
  b = await seedLeakTenant(db, auth, { tenantId: uuidv7(), tag: "http-b" });
  runner = createJobRunner({
    jobsUrl: testDb.jobsUrl,
    db,
    onError: (err) => {
      throw err;
    },
  });
  await runner.start();
  await ensureJobQueues(runner, services().config);
});
afterAll(async () => {
  await runner?.stop();
  await auth?.close();
  await db?.close();
  await testDb?.stop();
});

describe("durable idempotency through the public API middleware", () => {
  const body = {
    kind: "markdown",
    title: "Idempotent note",
    slug: "idempotent-note",
    content: "A note.",
  };

  it("replays across app and database-client recreation with one write and audit event", async () => {
    const first = await call(app(), "/v1/knowledge/sources", "durable", body);
    expect(first.status, await first.clone().text()).toBe(201);
    const original = await first.json();
    const freshDb = createDatabase(testDb.appUrl);
    try {
      const freshApp = createApp(composeServices({ ...services(), db: freshDb }), {
        authenticate: async () => principal(),
      });
      const replay = await freshApp.request("/v1/knowledge/sources", {
        method: "POST",
        headers: {
          "idempotency-key": "durable",
          "content-type": "application/json",
          "x-request-id": "durable-replay-request",
        },
        body: JSON.stringify(body),
      });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(replay.headers.get("x-request-id")).toBe("durable-replay-request");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "durable-replay-request", status: 201 }),
        "request completed",
      );
      expect(await replay.json()).toEqual(original);
    } finally {
      await freshDb.close();
    }
    const sources = await db.withTenant(a.tenantId, (tx) =>
      tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.slug, body.slug)),
    );
    expect(sources).toHaveLength(1);
    const id = sources[0]?.id;
    const audit = await db.withTenant(a.tenantId, (tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, id ?? "")),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("knowledge_source.created");
    const replayRow = (await rows()).find((row) => row.keyHash === hash("durable"));
    expect(replayRow?.responseStatus).toBe(201);
    expect(replayRow?.responseBody).not.toContain("hos_");
  });

  it("admits only one concurrent attempt and never repeats the side effect", async () => {
    const payload = { ...body, slug: "concurrent-note" };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(app(), "/v1/knowledge/sources", "concurrent", payload)),
    );
    expect(results.every((res) => [201, 409].includes(res.status))).toBe(true);
    expect(results.some((res) => res.status === 201)).toBe(true);
    const stored = await db.withTenant(a.tenantId, (tx) =>
      tx
        .select()
        .from(schema.knowledgeSources)
        .where(eq(schema.knowledgeSources.slug, payload.slug)),
    );
    expect(stored).toHaveLength(1);
    const retry = await call(app(), "/v1/knowledge/sources", "concurrent", payload);
    expect(retry.headers.get("idempotency-replayed")).toBe("true");
  });

  it("reports an in-flight durable reservation without entering a second handler", async () => {
    const instance = app();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    instance.openapi(
      apiRoute({
        operationId: "test.idempotency.pending",
        idempotency: "replay",
        method: "post",
        path: "/pending-probe",
        access: { allScopes: ["knowledge:write"] },
        audit: { records: ["knowledge_source.created"] },
        responses: { 204: { description: "probe" } },
      }),
      async (c) => {
        calls += 1;
        entered.resolve();
        await release.promise;
        nothingToAudit("probe changes nothing");
        return c.body(null, 204);
      },
    );
    const first = call(instance, "/pending-probe", "in-flight");
    await entered.promise;
    try {
      const duplicate = await call(instance, "/pending-probe", "in-flight");
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ error: "idempotency_pending" });
      expect(calls).toBe(1);
      expect((await rows()).find((row) => row.keyHash === hash("in-flight"))).toMatchObject({
        responseStatus: null,
      });
    } finally {
      release.resolve();
      await first;
    }
  });

  it("conflicts on body, path, method, query, content-type and current scopes", async () => {
    const instance = app();
    const variants = [
      () => call(instance, "/v1/knowledge/sources", "durable", { ...body, title: "Changed" }),
      () => call(instance, `/v1/conversations/${a.ids.conversation}/close`, "durable"),
      () => call(instance, "/v1/knowledge/sources?changed=1", "durable", body),
      () =>
        call(
          instance,
          `/v1/knowledge/sources/${a.ids.source}`,
          "durable",
          { title: "Changed" },
          "PATCH",
        ),
      () =>
        call(
          app({ ...principal(), scopes: new Set(["knowledge:write"]) }),
          "/v1/knowledge/sources",
          "durable",
          body,
        ),
      () =>
        instance.request("/v1/knowledge/sources", {
          method: "POST",
          headers: {
            "idempotency-key": "durable",
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        }),
    ];
    for (const variant of variants) {
      const res = await variant();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "idempotency_conflict" });
    }
  });

  it("isolates the same key by tenant, actor id and actor type", async () => {
    const otherTenant = await call(app(principal(b)), "/v1/knowledge/sources", "durable", body);
    expect(otherTenant.status).toBe(201);
    expect(otherTenant.headers.has("idempotency-replayed")).toBe(false);
    for (const caller of [
      principal(a, uuidv7()),
      { ...principal(), actor: { type: "agent" as const, id: a.ownerUserId } },
    ]) {
      const res = await call(app(caller), "/v1/knowledge/sources", "durable", body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "slug_taken" });
      expect(res.headers.has("idempotency-replayed")).toBe(false);
    }
    expect((await rows()).filter((row) => row.keyHash === hash("durable"))).toHaveLength(3);
    expect((await rows(b)).filter((row) => row.keyHash === hash("durable"))).toHaveLength(1);
  });

  it("refuses replay after actual token revocation and checks current authorization before parsing", async () => {
    const token = generateToken();
    const id = uuidv7();
    await db.withTenant(a.tenantId, (tx) =>
      tx.insert(schema.apiTokens).values({
        id,
        tenantId: a.tenantId,
        name: "replay-revocation",
        tokenHash: token.hash,
        scopes: ["conversations:read", "conversations:write"],
      }),
    );
    const realApp = createApp(services());
    const url = `/v1/conversations/${a.ids.conversation}/close`;
    const request = () =>
      realApp.request(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "idempotency-key": "revoked" },
      });
    expect((await request()).status).toBe(200);
    const revoked = await realApp.request(`/v1/tokens/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(revoked.status).toBe(204);
    expect((await request()).status).toBe(401);
    const denied = app({ ...principal(), scopes: new Set() });
    const res = await denied.request("/v1/knowledge/sources", {
      method: "POST",
      headers: { "idempotency-key": "durable", "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(403);
  });

  it("refuses credential-producing and noCaller keyed writes before side effects or storage", async () => {
    const before = await rows();
    const beforeTokens = await db.withTenant(a.tenantId, (tx) =>
      tx.select().from(schema.apiTokens),
    );
    const beforeIntegrations = await db.withTenant(a.tenantId, (tx) =>
      tx.select().from(schema.integrations),
    );
    for (const [method, path] of [
      ["POST", "/v1/tokens"],
      ["PUT", "/v1/integrations/github"],
      ["POST", "/v1/integrations/github/webhook-secret"],
      ["POST", "/v1/auth/sign-in"],
      ["POST", "/v1/auth/password"],
    ]) {
      const res = await call(
        app(),
        path ?? "",
        "secret",
        {
          name: "must-not-mint",
          scopes: ["conversations:read"],
          repo: "probe/repo",
          token: "must-not-store",
          email: "owner@example.test",
          password: "must-not-store",
        },
        method,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "idempotency_not_supported" });
    }
    expect(await rows()).toEqual(before);
    expect(await db.withTenant(a.tenantId, (tx) => tx.select().from(schema.apiTokens))).toEqual(
      beforeTokens,
    );
    expect(await db.withTenant(a.tenantId, (tx) => tx.select().from(schema.integrations))).toEqual(
      beforeIntegrations,
    );
  });

  it("preserves pending claims after a committed side effect and a lost response", async () => {
    const instance = app();
    let calls = 0;
    const route = apiRoute({
      operationId: "test.idempotency.crash",
      idempotency: "replay",
      method: "post",
      path: "/crash-probe",
      access: { allScopes: ["knowledge:write"] },
      audit: { records: ["knowledge_source.created"] },
      responses: {
        200: { description: "probe" },
        500: json(errorSchema, "Simulated response loss"),
      },
    });
    instance.openapi(route, async () => {
      calls += 1;
      await db.withTenant(a.tenantId, (tx) =>
        tx
          .update(schema.knowledgeSources)
          .set({ title: "committed before response failure" })
          .where(eq(schema.knowledgeSources.id, a.ids.source)),
      );
      throw new Error("simulated loss after commit");
    });
    expect((await call(instance, "/crash-probe", "crash")).status).toBe(500);
    const row = (await rows()).find((item) => item.keyHash === hash("crash"));
    expect(row).toMatchObject({ responseStatus: null, responseBody: null });
    const res = await call(instance, "/crash-probe", "crash");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "idempotency_pending" });
    expect(calls).toBe(1);
    const stored = await db.withTenant(a.tenantId, (tx) =>
      tx.select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, a.ids.source)),
    );
    expect(stored[0]?.title).toBe("committed before response failure");
    await db.withTenant(a.tenantId, (tx) =>
      tx
        .update(schema.httpIdempotency)
        .set({ expiresAt: new Date("2000-01-01T00:00:00Z") })
        .where(eq(schema.httpIdempotency.keyHash, hash("crash"))),
    );
    const expired = await call(instance, "/crash-probe", "crash");
    expect(await expired.json()).toMatchObject({ error: "idempotency_expired" });
    expect(calls).toBe(1);
  });

  it("replays terminal validation errors, expires responses without reexecution and supports empty 204", async () => {
    const invalid = await call(app(), "/v1/knowledge/sources", "invalid", {});
    expect(invalid.status).toBe(400);
    expect(
      (await call(app(), "/v1/knowledge/sources", "invalid", {})).headers.get(
        "idempotency-replayed",
      ),
    ).toBe("true");
    await db.withTenant(a.tenantId, (tx) =>
      tx
        .update(schema.httpIdempotency)
        .set({ expiresAt: new Date("2000-01-01T00:00:00Z") })
        .where(eq(schema.httpIdempotency.keyHash, hash("durable"))),
    );
    const expired = await call(app(), "/v1/knowledge/sources", "durable", body);
    expect(await expired.json()).toMatchObject({ error: "idempotency_expired" });
    expect((await rows()).find((row) => row.keyHash === hash("durable"))?.responseBody).toBeNull();
    const instance = app();
    instance.openapi(
      apiRoute({
        operationId: "test.idempotency.emptyResponse",
        idempotency: "replay",
        method: "delete",
        path: "/empty-probe",
        access: { allScopes: ["knowledge:write"] },
        audit: { records: ["knowledge_source.deleted"] },
        responses: { 204: { description: "empty" } },
      }),
      (c) => {
        nothingToAudit("unchanged probe");
        return c.body(null, 204);
      },
    );
    expect((await call(instance, "/empty-probe", "empty", undefined, "DELETE")).status).toBe(204);
    const replay = await instance.request("/empty-probe", {
      method: "DELETE",
      headers: {
        "idempotency-key": "empty",
        "content-type": "application/json",
        "x-request-id": "empty-replay-request",
      },
    });
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.headers.get("x-request-id")).toBe("empty-replay-request");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "empty-replay-request", status: 204 }),
      "request completed",
    );
  });
});
