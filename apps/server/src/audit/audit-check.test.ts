import type { TenantTx } from "@helpos/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { type Audit, apiRoute } from "../auth/access.ts";
import { openApiDocument } from "../openapi.ts";
import { type AuditAction, nothingToAudit, recordAudit } from "./audit.ts";
import { hashBody } from "./details.ts";

const doc = (await openApiDocument()) as {
  paths: Record<string, Record<string, { "x-audit"?: Audit }>>;
};
const writes = Object.entries(doc.paths).flatMap(([path, ops]) =>
  Object.entries(ops)
    .filter(([method]) => method !== "get")
    .map(([method, op]) => ({ method: method.toUpperCase(), path, audit: op["x-audit"] })),
);

describe("every write operation declares what it audits", () => {
  it("found them", () => {
    expect(writes.length).toBeGreaterThan(15);
  });

  it.each(writes)("$method $path has x-audit", ({ audit }) => {
    expect(audit, "define the route with apiRoute() and give it `audit`").toBeDefined();
    if (audit && "none" in audit) {
      expect(audit.none.length, "say why the route has nothing to audit").toBeGreaterThan(10);
    }
  });
});

// Only the insert is used: recordAudit() writes one row.
const tx = { insert: () => ({ values: async () => {} }) } as unknown as TenantTx;
const record = (action: AuditAction) =>
  recordAudit(tx, {
    tenantId: "0190d6a4-0000-7000-8000-000000000001",
    actor: { type: "system", id: "test" },
    action,
    target: { type: "conversation", id: "0190d6a4-0000-7000-8000-000000000002" },
    requestId: null,
    ...(action === "draft.created"
      ? {
          details: {
            bodyHash: hashBody("fixture draft"),
            messageId: "0190d6a4-0000-7000-8000-000000000003",
            kind: "reply" as const,
          },
        }
      : {}),
  });

/** One write route that records `conversation.closed`, whose handler does `handle` then answers. */
function appWith(handle: () => Promise<void> | void, status: 200 | 409 = 200) {
  const app = new OpenAPIHono();
  const route = apiRoute({
    access: { noCaller: "a test route, called without any principal" },
    audit: { records: ["conversation.closed"] },
    method: "post",
    path: "/close",
    responses: { 200: { description: "closed" }, 409: { description: "refused" } },
  });
  app.openapi(route, async (c) => {
    await handle();
    return c.body(null, status);
  });
  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}

async function post(app: OpenAPIHono) {
  const res = await app.request("/close", { method: "POST" });
  return { status: res.status, body: res.status === 500 ? await res.json() : null };
}

describe("a write route's audit is checked after its handler", () => {
  it("passes a success that records a declared action", async () => {
    expect((await post(appWith(() => record("conversation.closed")))).status).toBe(200);
  });

  it("fails a success that records nothing, and says how to fix it", async () => {
    expect(await post(appWith(() => {}))).toEqual({
      status: 500,
      body: {
        error:
          "POST /close succeeded without an audit event: call recordAudit() in the handler's " +
          "transaction, or nothingToAudit() when the request changed nothing",
      },
    });
  });

  it("passes a success that changed nothing and says so", async () => {
    expect((await post(appWith(() => nothingToAudit("already closed")))).status).toBe(200);
  });

  it("fails an action the route didn't declare", async () => {
    expect(await post(appWith(() => record("draft.created")))).toEqual({
      status: 500,
      body: { error: "POST /close recorded draft.created: add it to the route's audit.records" },
    });
  });

  it("doesn't ask a refused request for an audit event", async () => {
    expect((await post(appWith(() => {}, 409))).status).toBe(409);
  });
});
