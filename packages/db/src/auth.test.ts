import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuthStore, createAuthStore, type SessionAuth } from "./auth.ts";
import { startTestDatabase, type TestDatabase } from "./testing.ts";

// Human sign-in against real Postgres, as the auth role (ADR 0009 §1).

let testDb: TestDatabase;
let auth: AuthStore;
let sessions: SessionAuth;
const password = "correct horse battery staple";

beforeAll(async () => {
  testDb = await startTestDatabase();
  auth = createAuthStore(testDb.authUrl, {
    sessions: {
      secret: "test-secret-that-is-at-least-32-characters-long",
      baseUrl: "http://localhost:3000",
      cookiePrefix: "test",
    },
  });
  if (!auth.sessions) throw new Error("sessions not configured");
  sessions = auth.sessions;
});

afterAll(async () => {
  await auth?.close();
  await testDb?.container.stop();
});

/** The `Cookie` header a browser would send back after these `Set-Cookie` lines. */
function cookieFrom(setCookie: string[]): Headers {
  return new Headers({ cookie: setCookie.map((c) => c.split(";")[0]).join("; ") });
}

async function userWithPassword(email: string) {
  const user = await auth.ensureUser(email);
  const { token } = await auth.issueSetupToken(user.id);
  expect(await auth.setPassword(token, password)).toEqual({ ok: true });
  return user;
}

describe("password setup link", () => {
  it("sets the password once; the same token never works again", async () => {
    const user = await auth.ensureUser("once@a.test");
    expect(await auth.hasPassword(user.id)).toBe(false);
    const { token, expiresAt } = await auth.issueSetupToken(user.id);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await auth.setPassword(token, password)).toEqual({ ok: true });
    expect(await auth.hasPassword(user.id)).toBe(true);
    expect(await auth.setPassword(token, "another long password")).toEqual({ ok: false });
  });

  it("refuses an unknown token and a too-short password, leaving the token usable", async () => {
    const user = await auth.ensureUser("short@a.test");
    const { token } = await auth.issueSetupToken(user.id);
    expect(await auth.setPassword("not-a-real-token", password)).toEqual({ ok: false });
    expect(await auth.setPassword(token, "short")).toEqual({ ok: false });
    expect(await auth.setPassword(token, password)).toEqual({ ok: true });
  });

  it("a new link replaces the old one", async () => {
    const user = await auth.ensureUser("relink@a.test");
    const first = await auth.issueSetupToken(user.id);
    const second = await auth.issueSetupToken(user.id);
    expect(await auth.setPassword(first.token, password)).toEqual({ ok: false });
    expect(await auth.setPassword(second.token, password)).toEqual({ ok: true });
  });

  it("refuses an expired token", async () => {
    const user = await auth.ensureUser("expired@a.test");
    const { token } = await auth.issueSetupToken(user.id);
    const owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      await owner`update auth.verifications set expires_at = now() - interval '1 second'`;
    } finally {
      await owner.end();
    }
    expect(await auth.setPassword(token, password)).toEqual({ ok: false });
  });

  it("stores only a hash of the token", async () => {
    const user = await auth.ensureUser("hashed@a.test");
    const { token } = await auth.issueSetupToken(user.id);
    const owner = postgres(testDb.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      const rows = await owner`select identifier from auth.verifications where value = ${user.id}`;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
    } finally {
      await owner.end();
    }
  });
});

describe("sessions", () => {
  it("signs in with the right password and resolves the session from its cookie", async () => {
    const user = await userWithPassword("signin@a.test");
    const result = await sessions.signIn("SignIn@A.test", password, new Headers());
    if (!result.ok) throw new Error("sign-in failed");
    expect(result.userId).toBe(user.id);
    const cookie = result.setCookie.find((c) => c.startsWith("test.session_token="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(await sessions.resolveSession(cookieFrom(result.setCookie))).toEqual({
      userId: user.id,
      email: "signin@a.test",
    });
  });

  it("a wrong password and an unknown email give the same answer", async () => {
    await userWithPassword("wrong@a.test");
    expect(await sessions.signIn("wrong@a.test", "not the password!", new Headers())).toEqual({
      ok: false,
    });
    expect(await sessions.signIn("nobody@a.test", password, new Headers())).toEqual({
      ok: false,
    });
    expect(await sessions.signIn("not an email", password, new Headers())).toEqual({ ok: false });
  });

  it("a user without a password can't sign in", async () => {
    await auth.ensureUser("nopassword@a.test");
    expect(await sessions.signIn("nopassword@a.test", password, new Headers())).toEqual({
      ok: false,
    });
  });

  it("no cookie, or a forged one, resolves to nobody", async () => {
    expect(await sessions.resolveSession(new Headers())).toBeNull();
    expect(
      await sessions.resolveSession(new Headers({ cookie: "test.session_token=forged.value" })),
    ).toBeNull();
  });

  it("signing out ends the session", async () => {
    await userWithPassword("signout@a.test");
    const result = await sessions.signIn("signout@a.test", password, new Headers());
    if (!result.ok) throw new Error("sign-in failed");
    const headers = cookieFrom(result.setCookie);
    const out = await sessions.signOut(headers);
    expect(out.setCookie.some((c) => c.startsWith("test.session_token=;"))).toBe(true);
    expect(await sessions.resolveSession(headers)).toBeNull();
  });

  it("setting a new password signs out existing sessions", async () => {
    const user = await userWithPassword("reset@a.test");
    const result = await sessions.signIn("reset@a.test", password, new Headers());
    if (!result.ok) throw new Error("sign-in failed");
    const { token } = await auth.issueSetupToken(user.id);
    expect(await auth.setPassword(token, "a brand new password")).toEqual({ ok: true });
    expect(await sessions.resolveSession(cookieFrom(result.setCookie))).toBeNull();
  });
});
