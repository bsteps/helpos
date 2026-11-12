import { isDeepStrictEqual } from "node:util";
import { createMemoryFileStore } from "@helpos/files";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { openApiDocument } from "../openapi.ts";
import { composeServices } from "../services.ts";
import type { Access } from "./access.ts";
import { type Principal, type Scope, scopes } from "./principal.ts";

// Sweeps every operation in the served API document, so a new route is covered the moment it
// exists. No database: a request that gets past the access check reaches `unused` and fails.

const unused = (): never => {
  throw new Error("the access check must refuse before any database call");
};

interface Operation {
  method: string;
  path: string;
  access: Access | undefined;
  responses: Record<string, unknown>;
}

async function operations(): Promise<Operation[]> {
  const doc = (await openApiDocument()) as {
    paths: Record<string, Record<string, { "x-access"?: Access; responses: object }>>;
  };
  return Object.entries(doc.paths).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      access: op["x-access"],
      responses: op.responses as Record<string, unknown>,
    })),
  );
}

function appAs(principal: Principal | null) {
  return createApp(
    composeServices({
      db: {
        ping: unused,
        withTenant: unused,
        resolveMailbox: unused,
        resolveApiToken: unused,
        listMemberships: unused,
      },
      files: createMemoryFileStore(),
      logger: { error: () => {}, warn: () => {}, info: () => {} },
    }),
    { authenticate: async () => principal },
  );
}

const as = (type: "user" | "agent", held: readonly Scope[]): Principal => ({
  tenantId: "0190d6a4-0000-7000-8000-000000000001",
  actor: { type, id: "0190d6a4-0000-7000-8000-000000000002" },
  scopes: new Set(held),
});

async function call(op: Operation, principal: Principal | null) {
  const url = op.path.replaceAll(/\{[^}]+\}/g, "0190d6a4-0000-7000-8000-000000000003");
  const init: RequestInit = { method: op.method };
  if (op.method !== "GET") {
    init.headers = { "content-type": "application/json" };
    init.body = "{";
  }
  return appAs(principal).request(url, init);
}

const ops = await operations();
const scoped = ops.flatMap((op) => {
  const a = op.access;
  return a && ("allScopes" in a || "anyScope" in a) ? [{ ...op, access: a }] : [];
});

describe("every API operation declares who may call it", () => {
  it("found the operations", () => {
    expect(scoped.length).toBeGreaterThan(20);
  });

  it.each(ops)("$method $path has x-access", (op) => {
    expect(
      op.access,
      `${op.method} ${op.path}: define the route with apiRoute() from src/auth/access.ts and give it an \`access\``,
    ).toBeDefined();
  });
});

describe("the declared access is enforced, before the body is read", () => {
  it.each(scoped)("$method $path documents 401 and 403", (op) => {
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["401", "403"]));
  });

  it.each(scoped)("$method $path refuses a caller with no credentials (401)", async (op) => {
    expect((await call(op, null)).status).toBe(401);
  });

  it.each(scoped)("$method $path refuses a caller with no scopes (403)", async (op) => {
    expect((await call(op, as("user", []))).status).toBe(403);
  });

  it.each(scoped.filter((op) => "allScopes" in op.access && op.access.allScopes.length > 1))(
    "$method $path refuses a caller missing any one of its scopes (403)",
    async (op) => {
      const required = "allScopes" in op.access ? op.access.allScopes : [];
      for (const missing of required) {
        const res = await call(
          op,
          as(
            "user",
            scopes.filter((s) => s !== missing),
          ),
        );
        expect(res.status, `without ${missing}`).toBe(403);
      }
    },
  );

  it.each(scoped.filter((op) => op.access.humansOnly))(
    "$method $path refuses an agent even with every scope (403 session_required)",
    async (op) => {
      const res = await call(op, as("agent", scopes));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "session_required" });
    },
  );
});

type CatalogAccess =
  | { allScopes: readonly string[]; humansOnly?: true }
  | { anyScope: readonly string[]; humansOnly?: true }
  | Extract<Access, { noCaller: string } | { anyCaller: string } | { selfOrAdmin: object }>;
type CatalogOperation = Omit<Operation, "access"> & { access: CatalogAccess | undefined };

const callerExceptions: Record<string, CatalogAccess> = {
  "GET /health": {
    noCaller: "Liveness reveals only that the HTTP process can answer a request.",
  },
  "GET /readyz": {
    noCaller: "Readiness reveals only whether the database and job queues are available.",
  },
  "POST /v1/auth/sign-in": {
    noCaller: "The caller proves who they are with an email and password in the body.",
  },
  "POST /v1/auth/sign-out": {
    noCaller:
      "The session cookie, if any, is the only credential, and signing out without one is harmless.",
  },
  "POST /v1/auth/password": {
    noCaller: "The one-time token in the body proves the caller holds the password setup link.",
  },
  "POST /v1/inbound/email": {
    noCaller: "The email provider proves itself with the shared inbound secret.",
  },
  "POST /v1/integrations/github/webhook": {
    noCaller:
      "GitHub proves itself with an HMAC signature of the body, made with the workspace webhook secret.",
  },
  "GET /v1/me": {
    anyCaller: "Every caller may ask who it is; the answer is its own identity and scopes.",
  },
};

const githubRead = {
  key: "GET /v1/integrations/github",
  access: { anyScope: ["github:write", "workspace:admin"] },
  reason:
    "The connection summary is available to GitHub operators and human admins; no github:read scope exists.",
} satisfies { key: string; access: CatalogAccess; reason: string };
const adminRead = {
  key: "GET /v1/tokens",
  access: { allScopes: ["workspace:admin"], humansOnly: true },
  reason: "Only human admins may list credentials; no tokens:read scope exists.",
} satisfies { key: string; access: CatalogAccess; reason: string };
const selfRevoke = {
  key: "DELETE /v1/tokens/{id}",
  access: { selfOrAdmin: { tokenIdParam: "id" } },
  reason:
    "An agent may revoke only its own token, and a human admin may revoke any tenant-local token.",
} satisfies { key: string; access: CatalogAccess; reason: string };

const resourceExceptions = [
  selfRevoke,
  ...(
    [
      ["PATCH /v1/drafts/{id}", "drafts:write"],
      ["POST /v1/drafts/{id}/approve", "drafts:approve"],
      ["POST /v1/drafts/{id}/discard", "drafts:write"],
      ["POST /v1/drafts/{id}/retry", "drafts:approve"],
    ] as const
  ).map(([key, scope]) => ({
    key,
    access: { allScopes: [scope] },
    reason:
      "Draft operations use the existing write or approve capability; no drafts:read scope exists.",
  })),
  {
    key: "POST /v1/drafts/{id}/resolve-send",
    access: { allScopes: ["drafts:approve"], humansOnly: true },
    reason: "A human resolves an uncertain send using the existing approval capability.",
  },
] satisfies { key: string; access: CatalogAccess; reason: string }[];

function checkAccess(op: CatalogOperation): string[] {
  const key = `${op.method} ${op.path}`;
  const a = op.access;
  if (!a) return [`${key}: missing access`];
  const failures: string[] = [];
  if ("noCaller" in a || "anyCaller" in a) {
    if (!isDeepStrictEqual(callerExceptions[key], a)) {
      failures.push(`${key}: unreviewed caller exception`);
    }
  }
  if ("selfOrAdmin" in a && (key !== selfRevoke.key || !isDeepStrictEqual(a, selfRevoke.access))) {
    failures.push(`${key}: unreviewed self-or-admin access`);
  }
  const required = "allScopes" in a ? a.allScopes : "anyScope" in a ? a.anyScope : [];
  const reviewedGithubRead = key === githubRead.key && isDeepStrictEqual(a, githubRead.access);
  if (
    required.includes("workspace:admin") &&
    !("humansOnly" in a && a.humansOnly) &&
    !reviewedGithubRead
  ) {
    failures.push(`${key}: workspace:admin requires humansOnly`);
  }
  if (required.length > 0) {
    const matchesMethod = (scope: string) =>
      op.method === "GET" ? scope.endsWith(":read") : !scope.endsWith(":read");
    const consistent =
      "allScopes" in a ? required.some(matchesMethod) : required.every(matchesMethod);
    const reviewedAdminRead = key === adminRead.key && isDeepStrictEqual(a, adminRead.access);
    if (!consistent && !reviewedGithubRead && !reviewedAdminRead) {
      failures.push(`${key}: method conflicts with scopes`);
    }
  }
  const resource = op.path.match(/^\/v1\/([^/]+)\/\{[^/]+\}(?:\/|$)/)?.[1];
  if (resource) {
    const read = `${resource}:read`;
    const requiresRead =
      "allScopes" in a
        ? a.allScopes.includes(read)
        : "anyScope" in a && a.anyScope.every((s) => s === read);
    const reviewed = resourceExceptions.some(
      (entry) => entry.key === key && isDeepStrictEqual(entry.access, a),
    );
    if (!requiresRead && !reviewed) failures.push(`${key}: requires ${read}`);
  }
  return failures;
}

describe("reviewed access rules across the served catalog", () => {
  it.each(ops)("$method $path satisfies the access sweeps", (op) => {
    expect(checkAccess(op)).toEqual([]);
  });

  it("keeps every reviewed exception tied to its exact operation and access", () => {
    for (const [key, access] of Object.entries(callerExceptions)) {
      expect(ops.find((op) => `${op.method} ${op.path}` === key)?.access, key).toEqual(access);
    }
    for (const entry of [githubRead, adminRead, ...resourceExceptions]) {
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(ops.find((op) => `${op.method} ${op.path}` === entry.key)?.access, entry.key).toEqual(
        entry.access,
      );
    }
  });

  it.each([
    [
      "human-only",
      "PATCH",
      "/v1/workspace/shadow-mode",
      { allScopes: ["workspace:admin"] },
      "workspace:admin requires humansOnly",
    ],
    [
      "noCaller",
      "POST",
      "/v1/future",
      { noCaller: "A plausible reason longer than ten characters." },
      "unreviewed caller exception",
    ],
    [
      "anyCaller",
      "GET",
      "/v1/future",
      { anyCaller: "A plausible reason longer than ten characters." },
      "unreviewed caller exception",
    ],
    [
      "changed reason",
      "GET",
      "/v1/me",
      { anyCaller: "An altered reason must receive another review." },
      "unreviewed caller exception",
    ],
    [
      "GET write scope",
      "GET",
      "/v1/future",
      { allScopes: ["drafts:write"] },
      "method conflicts with scopes",
    ],
    [
      "GET approve scope",
      "GET",
      "/v1/future",
      { allScopes: ["drafts:approve"] },
      "method conflicts with scopes",
    ],
    [
      "GET admin scope",
      "GET",
      "/v1/future",
      { allScopes: ["workspace:admin"], humansOnly: true },
      "method conflicts with scopes",
    ],
    [
      "GET anyScope bypass",
      "GET",
      "/v1/future",
      { anyScope: ["conversations:read", "drafts:write"] },
      "method conflicts with scopes",
    ],
    [
      "write anyScope bypass",
      "POST",
      "/v1/future",
      { anyScope: ["conversations:read", "drafts:write"] },
      "method conflicts with scopes",
    ],
    ...["POST", "PUT", "PATCH", "DELETE"].map(
      (method) =>
        [
          "read-only write",
          method,
          "/v1/future",
          { allScopes: ["conversations:read"] },
          "method conflicts with scopes",
        ] as const,
    ),
    ...["decisions", "rules", "claims"].map(
      (resource) =>
        [
          "future resource",
          "POST",
          `/v1/${resource}/{decisionId}/act`,
          { allScopes: [`${resource}:write`] },
          `requires ${resource}:read`,
        ] as const,
    ),
    [
      "resource anyScope bypass",
      "GET",
      "/v1/conversations/{id}",
      { anyScope: ["conversations:read", "knowledge:read"] },
      "requires conversations:read",
    ],
    [
      "resource noCaller bypass",
      "GET",
      "/v1/conversations/{id}",
      { noCaller: "A plausible reason longer than ten characters." },
      "requires conversations:read",
    ],
    [
      "copied self access",
      "DELETE",
      "/v1/future/{id}",
      selfRevoke.access,
      "unreviewed self-or-admin access",
    ],
    [
      "broadened reviewed scope",
      "POST",
      "/v1/drafts/{id}/approve",
      { anyScope: ["drafts:approve", "stats:read"] },
      "requires drafts:read",
    ],
  ] satisfies (readonly [string, string, string, CatalogAccess, string])[])(
    "rejects a broken catalog fixture for %s",
    (_, method, path, access, error) => {
      expect(checkAccess({ method, path, access, responses: {} })).toContain(
        `${method} ${path}: ${error}`,
      );
    },
  );

  it.each(["decisions", "rules", "claims"])(
    "accepts a future %s route once it requires its read scope",
    (resource) => {
      expect(
        checkAccess({
          method: "POST",
          path: `/v1/${resource}/{resourceId}/act`,
          access: { allScopes: [`${resource}:read`, `${resource}:write`] },
          responses: {},
        }),
      ).toEqual([]);
    },
  );
});

const selfOrAdminOps = ops.filter((op) => op.access && "selfOrAdmin" in op.access);
describe("self-or-admin access precedes parameter validation and database work", () => {
  it("is limited to token revocation", () => {
    expect(selfOrAdminOps.map((op) => `${op.method} ${op.path}`)).toEqual([selfRevoke.key]);
  });

  it.each([null, as("user", []), as("agent", []), as("agent", scopes)])(
    "refuses an unauthorized caller before parsing the token ID",
    async (principal) => {
      const res = await appAs(principal).request("/v1/tokens/not-a-uuid", { method: "DELETE" });
      expect(res.status).toBe(principal ? 403 : 401);
      expect(await res.json()).toMatchObject({ error: principal ? "forbidden" : "unauthorized" });
    },
  );

  it("allows a human admin to reach parameter validation", async () => {
    const res = await appAs(as("user", ["workspace:admin"])).request("/v1/tokens/not-a-uuid", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });
});
