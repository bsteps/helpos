import {
  type AuthStore,
  type Database,
  eq,
  passwordSchema,
  type SessionAuth,
  schema,
} from "@helpos/db";
import { type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { errorResponse, errorSchema, json, jsonBody } from "../http/route-kit.ts";
import { apiRoute } from "./access.ts";
import { scopes } from "./principal.ts";
import { fromForeignOrigin } from "./session.ts";

export interface AuthRoutesDeps {
  db: Pick<Database, "withTenant">;
  /** Undefined when no HELPOS_AUTH_SECRET is set: sign-in then answers 503. */
  sessions: SessionAuth | undefined;
  /** Undefined without HELPOS_DATABASE_AUTH_URL: setting a password then answers 503. */
  passwords: Pick<AuthStore, "setPassword"> | undefined;
  /** The dashboard's origin. Browser requests from any other origin are refused. */
  trustedOrigin: string;
}

const disabled = { 503: json(errorSchema, "Human sign-in isn't configured on this server") };
const foreignOrigin = {
  403: json(errorSchema, "Sent by a browser from another site (`forbidden_origin`)"),
};

const meSchema = z
  .object({
    actor: z.object({ type: z.enum(["user", "agent"]), id: z.string() }),
    workspace: z.object({ id: z.uuid(), name: z.string() }),
    scopes: z.array(z.enum(scopes)),
  })
  .openapi("Me");

const signInRoute = apiRoute({
  operationId: "auth.signIn",
  idempotency: { refuse: "No caller to scope the key to, and the response sets a session cookie." },
  access: { noCaller: "The caller proves who they are with an email and password in the body." },
  audit: { none: "Signing in changes no workspace data, and users live outside workspaces." },
  method: "post",
  path: "/v1/auth/sign-in",
  summary: "Sign in with email and password",
  description:
    "Starts a human session and sets it as an HttpOnly cookie. A wrong email and a wrong " +
    "password get the same answer. There is no sign-up: users are created by the operator. " +
    "Agents use tokens instead (`POST /v1/tokens`).",
  request: {
    body: jsonBody(
      z.strictObject({ email: z.string().max(320), password: z.string().min(1).max(1000) }),
    ),
  },
  responses: {
    204: { description: "Signed in; the session cookie is set" },
    401: json(errorSchema, "Wrong email or password (`invalid_credentials`)"),
    ...foreignOrigin,
    ...disabled,
  },
});

const signOutRoute = apiRoute({
  operationId: "auth.signOut",
  idempotency: { refuse: "No caller to scope the key to; signing out again is harmless." },
  access: {
    noCaller:
      "The session cookie, if any, is the only credential, and signing out without one is harmless.",
  },
  audit: { none: "Ends the caller's own session; it changes no workspace data." },
  method: "post",
  path: "/v1/auth/sign-out",
  summary: "Sign out",
  description: "Ends the current session and clears its cookie. Safe to call without one.",
  responses: { 204: { description: "Signed out" }, ...foreignOrigin, ...disabled },
});

const setPasswordRoute = apiRoute({
  operationId: "auth.setPassword",
  idempotency: { refuse: "No caller to scope the key to; the one-time link proves the caller." },
  access: {
    noCaller: "The one-time token in the body proves the caller holds the password setup link.",
  },
  audit: { none: "Users live outside workspaces, and the audit log belongs to one workspace." },
  method: "post",
  path: "/v1/auth/password",
  summary: "Set a password with a one-time link",
  description:
    "Uses the token from a password setup link (printed by `helpos:init`) to set the user's " +
    `password, ${passwordSchema.minLength ?? 12} to ${passwordSchema.maxLength ?? 128} ` +
    "characters. The token works once. Every existing session of that user is signed out.",
  request: {
    body: jsonBody(z.strictObject({ token: z.string().min(1).max(200), password: passwordSchema })),
  },
  responses: {
    204: { description: "Password set; sign in with it" },
    400: json(errorSchema, "The link is unknown, used or expired (`invalid_token`)"),
    ...foreignOrigin,
    ...disabled,
  },
});

const meRoute = apiRoute({
  operationId: "auth.getIdentity",
  access: {
    anyCaller: "Every caller may ask who it is; the answer is its own identity and scopes.",
  },
  method: "get",
  path: "/v1/me",
  summary: "Who is calling",
  description: "The caller's identity, workspace and scopes. Works for sessions and tokens.",
  responses: { 200: json(meSchema, "The caller") },
});

/** Copies Better Auth's cookies onto our response. */
function setCookies(c: Context, cookies: string[]): void {
  for (const cookie of cookies) c.header("set-cookie", cookie, { append: true });
}

export function registerAuthRoutes(app: OpenAPIHono, deps: AuthRoutesDeps): void {
  app.use("/v1/auth/*", async (c, next) => {
    if (fromForeignOrigin(c.req.raw, deps.trustedOrigin)) {
      return errorResponse(c, { error: "forbidden_origin" }, 403);
    }
    // Answers about credentials must never be cached by a proxy or the browser.
    c.header("cache-control", "no-store");
    return next();
  });

  app.openapi(signInRoute, async (c) => {
    if (!deps.sessions) return errorResponse(c, { error: "sessions_disabled" }, 503);
    const { email, password } = c.req.valid("json");
    const result = await deps.sessions.signIn(email, password, c.req.raw.headers);
    if (!result.ok) return errorResponse(c, { error: "invalid_credentials" }, 401);
    setCookies(c, result.setCookie);
    return c.body(null, 204);
  });

  app.openapi(signOutRoute, async (c) => {
    if (!deps.sessions) return errorResponse(c, { error: "sessions_disabled" }, 503);
    const { setCookie } = await deps.sessions.signOut(c.req.raw.headers);
    setCookies(c, setCookie);
    return c.body(null, 204);
  });

  app.openapi(setPasswordRoute, async (c) => {
    if (!deps.passwords) return errorResponse(c, { error: "sessions_disabled" }, 503);
    const { token, password } = c.req.valid("json");
    const result = await deps.passwords.setPassword(token, password);
    if (!result.ok) return errorResponse(c, { error: "invalid_token" }, 400);
    return c.body(null, 204);
  });

  app.openapi(meRoute, async (c) => {
    const principal = c.get("principal");
    const [workspace] = await deps.db.withTenant(principal.tenantId, (tx) =>
      tx
        .select({ id: schema.tenants.id, name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, principal.tenantId)),
    );
    if (!workspace) return errorResponse(c, { error: "unauthorized" }, 401);
    return c.json(
      {
        actor: { type: principal.actor.type, id: principal.actor.id },
        workspace,
        scopes: scopes.filter((s) => principal.scopes.has(s)),
      },
      200,
    );
  });
}
