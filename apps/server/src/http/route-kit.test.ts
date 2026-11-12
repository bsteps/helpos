import type { TenantTx } from "@helpos/db";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { describe, expect, it } from "vitest";
import { apiRoute } from "../auth/access.ts";
import { callerResolver, type Principal } from "../auth/principal.ts";
import { auditor, errorSchema, json, notFound, notFoundResponse } from "./route-kit.ts";

const principal: Principal = {
  tenantId: "0190d6a4-0000-7000-8000-000000000001",
  actor: { type: "agent", id: "0190d6a4-0000-7000-8000-000000000002" },
  scopes: new Set(["conversations:read"]),
};

describe("JSON response media", () => {
  it("distinguishes a resource's nullable error field from a typed API error", () => {
    expect(
      Object.keys(json(z.object({ error: z.string().nullable() }), "Resource").content),
    ).toEqual(["application/json"]);
    expect(Object.keys(json(errorSchema, "Problem").content)).toEqual(["application/problem+json"]);
    expect(
      Object.keys(json(errorSchema.extend({ sourceId: z.uuid() }), "Extended problem").content),
    ).toEqual(["application/problem+json"]);
  });
});

/** What `recordAudit` inserts, so a test can read what the helper filled in. */
function fakeTx() {
  const rows: Record<string, unknown>[] = [];
  const tx = {
    insert: () => ({ values: async (row: Record<string, unknown>) => void rows.push(row) }),
  } as unknown as TenantTx;
  return { tx, rows };
}

const readRoute = apiRoute({
  operationId: "test.routeKit.readThing",
  access: { allScopes: ["conversations:read"] },
  method: "get",
  path: "/thing",
  responses: { 200: { description: "ok" }, 404: notFoundResponse },
});

function appWith(resolve: ((r: Request) => Promise<Principal | null>) | null) {
  const app = new OpenAPIHono();
  app.use("*", requestId());
  if (resolve) app.use("*", callerResolver(resolve));
  return app;
}

describe("apiRoute operation names", () => {
  it.each(["", " ", "\t\n"])("refuses a blank operationId %j", (operationId) => {
    expect(() =>
      apiRoute({
        operationId,
        access: { noCaller: "Only tests operation naming." },
        method: "get",
        path: "/name-probe",
        responses: { 200: { description: "ok" } },
      }),
    ).toThrow("apiRoute requires a nonempty operationId");
  });

  it("keeps the declared semantic name when a path changes", () => {
    for (const path of ["/before", "/after"]) {
      const app = new OpenAPIHono();
      const route = apiRoute({
        operationId: "test.routeKit.stableName",
        access: { noCaller: "Only tests operation naming." },
        method: "get",
        path,
        responses: { 200: { description: "ok" } },
      });
      app.openapi(route, (c) => c.body(null, 200));
      const doc = app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "Test", version: "0" },
      });
      expect(doc.paths?.[path]?.get?.operationId).toBe("test.routeKit.stableName");
    }
  });
});

describe("apiRoute resolves the caller itself", () => {
  it("lets a caller with the scope in, with no path middleware registered", async () => {
    const app = appWith(async () => principal);
    app.openapi(readRoute, (c) => c.json({ ok: c.get("principal").actor.id }, 200 as never));
    const res = await app.request("/thing");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: principal.actor.id });
  });

  it("answers 401 when the request carries no valid credentials", async () => {
    const app = appWith(async () => null);
    app.openapi(readRoute, (c) => notFound(c));
    expect((await app.request("/thing")).status).toBe(401);
  });

  it("refuses everyone when the app never said how to resolve callers", async () => {
    const app = appWith(null);
    app.openapi(readRoute, (c) => notFound(c));
    expect((await app.request("/thing")).status).toBe(401);
  });

  it("reuses a principal already set on the request instead of authenticating again", async () => {
    let calls = 0;
    const app = appWith(async () => {
      calls += 1;
      return principal;
    });
    app.use("/thing", async (c, next) => {
      c.set("principal", principal);
      await next();
    });
    app.openapi(readRoute, (c) => notFound(c));
    await app.request("/thing");
    expect(calls).toBe(0);
  });
});

describe("apiRoute documents what its access implies", () => {
  const spec = (access: Parameters<typeof apiRoute>[0]["access"]) => {
    const route = apiRoute({
      operationId: "test.routeKit.accessDocumentation",
      access,
      method: "get",
      path: "/x",
      responses: { 200: { description: "ok" } },
    });
    return route as unknown as { security?: unknown; responses: Record<string, unknown> };
  };

  it("adds the apiAuth scheme and 401 + 403 to a scoped route", () => {
    const route = spec({ allScopes: ["conversations:read"] });
    expect(route.security).toEqual([{ apiAuth: [] }]);
    expect(Object.keys(route.responses).sort()).toEqual(["200", "401", "403"]);
  });

  it("adds only 401 to an anyCaller route", () => {
    const route = spec({ anyCaller: "every caller may ask, for a reason" });
    expect(Object.keys(route.responses).sort()).toEqual(["200", "401"]);
  });

  it("adds nothing to a noCaller route, which proves its caller another way", () => {
    const route = spec({ noCaller: "a provider secret proves the caller" });
    expect(route.security).toBeUndefined();
    expect(Object.keys(route.responses)).toEqual(["200"]);
  });

  it("lets a route say something more specific than the default", () => {
    const route = apiRoute({
      operationId: "test.routeKit.overrideResponse",
      access: { allScopes: ["workspace:admin"], humansOnly: true },
      method: "get",
      path: "/x",
      responses: { 200: { description: "ok" }, 403: json(errorSchema, "A session is required") },
    }) as unknown as { responses: Record<string, { description: string }> };
    expect(route.responses["403"]?.description).toBe("A session is required");
  });
});

describe("auditor() binds the request", () => {
  it("records the caller's workspace and identity and the request ID", async () => {
    const { tx, rows } = fakeTx();
    const app = appWith(async () => principal);
    app.openapi(readRoute, async (c) => {
      await auditor(c)(tx, "conversation.closed", { type: "conversation", id: "t-1" });
      return notFound(c);
    });
    const res = await app.request("/thing", { headers: { "x-request-id": "req-123" } });
    expect(res.status).toBe(404);
    expect(rows).toEqual([
      {
        tenantId: principal.tenantId,
        actorType: "agent",
        actorId: principal.actor.id,
        action: "conversation.closed",
        details: {},
        targetType: "conversation",
        targetId: "t-1",
        requestId: "req-123",
      },
    ]);
  });
});
