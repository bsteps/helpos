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

const auditExceptions: Record<string, string> = {
  "POST /v1/auth/sign-in":
    "Signing in changes no workspace data, and users live outside workspaces.",
  "POST /v1/auth/sign-out": "Ends the caller's own session; it changes no workspace data.",
  "POST /v1/auth/password":
    "Users live outside workspaces, and the audit log belongs to one workspace.",
  "POST /v1/inbound/email":
    "A customer's email, not an action by a member or agent: the stored message is its record.",
  "POST /v1/integrations/github/webhook":
    "Each change a delivery applies is audited where it's applied, with GitHub as the actor.",
};

function checkAudit(op: (typeof writes)[number]): string[] {
  const key = `${op.method} ${op.path}`;
  if (!op.audit) return [`${key}: missing audit`];
  if ("none" in op.audit && auditExceptions[key] !== op.audit.none) {
    return [`${key}: unreviewed audit:none`];
  }
  return [];
}

describe("every write operation declares what it audits", () => {
  it("found them", () => {
    expect(writes.length).toBeGreaterThan(15);
  });

  it.each(writes)("$method $path has a reviewed audit declaration", (op) => {
    expect(checkAudit(op)).toEqual([]);
  });

  it("keeps every audit exception tied to its exact operation and reason", () => {
    for (const [key, none] of Object.entries(auditExceptions)) {
      expect(writes.find((op) => `${op.method} ${op.path}` === key)?.audit, key).toEqual({ none });
    }
  });

  it.each([
    ["POST", "/v1/future", undefined, "missing audit"],
    [
      "POST",
      "/v1/future",
      { none: "A plausible reason longer than ten characters." },
      "unreviewed audit:none",
    ],
    [
      "POST",
      "/v1/auth/sign-in",
      { none: "An altered reason must receive another review." },
      "unreviewed audit:none",
    ],
    [
      "DELETE",
      "/v1/auth/sign-in",
      { none: auditExceptions["POST /v1/auth/sign-in"] ?? "" },
      "unreviewed audit:none",
    ],
  ] satisfies [string, string, Audit | undefined, string][])(
    "rejects a broken %s %s audit fixture",
    (method, path, audit, error) => {
      expect(checkAudit({ method, path, audit })).toEqual([`${method} ${path}: ${error}`]);
    },
  );
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
