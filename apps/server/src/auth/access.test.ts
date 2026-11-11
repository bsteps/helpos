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

/** Calls the operation with an empty JSON body: refusal must come before validation. */
async function call(op: Operation, principal: Principal | null) {
  const url = op.path.replaceAll(/\{[^}]+\}/g, "0190d6a4-0000-7000-8000-000000000003");
  const init: RequestInit = { method: op.method };
  if (op.method !== "GET") {
    init.headers = { "content-type": "application/json" };
    init.body = "{}";
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

  it.each(ops.filter((op) => op.access && ("anyCaller" in op.access || "noCaller" in op.access)))(
    "$method $path says why it needs no scope",
    (op) => {
      const a = op.access;
      const reason = a && "anyCaller" in a ? a.anyCaller : a && "noCaller" in a ? a.noCaller : "";
      expect(reason.length, `${op.method} ${op.path}: the reason is empty`).toBeGreaterThan(10);
    },
  );
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
      expect(await res.json()).toEqual({ error: "session_required" });
    },
  );
});

describe("routes on a conversation need conversations:read", () => {
  // #108: creating a GitHub issue from a conversation checked only github:write, so a caller that
  // couldn't read the conversation could still pick its customer to be told. Anything under
  // /v1/conversations/{id} acts on that conversation and returns or uses its content.
  const onConversation = scoped.filter((op) => op.path.startsWith("/v1/conversations/{id}"));

  it("found them", () => {
    expect(onConversation.length).toBeGreaterThan(3);
  });

  it.each(onConversation)("$method $path requires conversations:read", (op) => {
    const required = "allScopes" in op.access ? op.access.allScopes : [];
    expect(
      required,
      `${op.method} ${op.path}: add "conversations:read" to its access.allScopes`,
    ).toContain("conversations:read");
  });
});
