import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { accounts, sessions, users, verifications } from "./schema.ts";
import { uuidv7 } from "./uuid.ts";

/**
 * The only code that connects as the `helpos_auth` role (ADR 0009 §1). The client and the
 * Better Auth instance stay in this module; the rest of the app gets these narrow functions.
 */
export interface AuthStore {
  /** Returns the user with this email, creating it if needed. Idempotent. */
  ensureUser(email: string): Promise<{ id: string; email: string }>;
  /**
   * The emails of these users, for notices to members of a workspace. Callers pass IDs read
   * from that workspace's memberships, so this can't be used to list users.
   */
  emailsOf(userIds: string[]): Promise<string[]>;
  /** Whether the user can sign in with a password yet. */
  hasPassword(userId: string): Promise<boolean>;
  /**
   * A one-time token that lets the user set their password, for the link `pnpm helpos:init`
   * prints. Any earlier setup token of theirs stops working.
   */
  issueSetupToken(userId: string): Promise<{ token: string; expiresAt: Date }>;
  /**
   * Uses a setup token: sets the password and signs out every existing session of that user.
   * The token works once. Unknown, used and expired tokens all fail the same way.
   */
  setPassword(token: string, password: string): Promise<{ ok: true } | { ok: false }>;
  /** Human sign-in. Null when sessions aren't configured (no HELPOS_AUTH_SECRET). */
  sessions: SessionAuth | null;
  close(): Promise<void>;
}

export interface SessionAuth {
  /** Checks email + password and starts a session. Wrong email and wrong password look alike. */
  signIn(
    email: string,
    password: string,
    headers: Headers,
  ): Promise<{ ok: true; userId: string; setCookie: string[] } | { ok: false }>;
  /** The signed-in user of a request, from its session cookie. */
  resolveSession(headers: Headers): Promise<{ userId: string; email: string } | null>;
  /** Ends the request's session. Returns the cookies that clear it in the browser. */
  signOut(headers: Headers): Promise<{ setCookie: string[] }>;
}

export interface SessionOptions {
  /** Signs session cookies. At least 32 characters. */
  secret: string;
  /** The dashboard's URL. Cookies are `Secure` when it is https. */
  baseUrl: string;
  /** Start of the cookie names, e.g. the brand slug. */
  cookiePrefix: string;
  /** Better Auth's own log lines. Never include passwords. */
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

/** Long enough to resist guessing; the upper bound keeps hashing cheap (Better Auth's limit). */
export const passwordSchema = z.string().min(12).max(128);
/** How long a password setup link works. */
export const passwordSetupTtlMs = 24 * 60 * 60 * 1000;

const emailSchema = z.email().trim().toLowerCase();
const userIdSchema = z.uuid();
const setupPrefix = "password-setup:";
const setupIdentifier = (token: string) =>
  `${setupPrefix}${createHash("sha256").update(token).digest("hex")}`;

export function createAuthStore(
  authUrl: string,
  options: { sessions?: SessionOptions } = {},
): AuthStore {
  const client = postgres(authUrl, { max: 4, connect_timeout: 5, onnotice: () => {} });
  const db = drizzle(client);

  return {
    async ensureUser(rawEmail) {
      const email = emailSchema.parse(rawEmail);
      // DO UPDATE (a no-op) instead of DO NOTHING, so RETURNING also gives back an existing row.
      const rows = await db
        .insert(users)
        .values({ email })
        .onConflictDoUpdate({ target: users.email, set: { email } })
        .returning({ id: users.id, email: users.email });
      const user = rows[0];
      if (!user) throw new Error("ensureUser: insert returned no row");
      return user;
    },
    async emailsOf(userIds) {
      if (userIds.length === 0) return [];
      const rows = await db
        .select({ email: users.email })
        .from(users)
        .where(inArray(users.id, userIds));
      return rows.map((r) => r.email).sort();
    },
    async hasPassword(rawUserId) {
      const userId = userIdSchema.parse(rawUserId);
      const rows = await db.select({ id: accounts.id }).from(accounts).where(credentialOf(userId));
      return rows.length > 0;
    },
    async issueSetupToken(rawUserId) {
      const userId = userIdSchema.parse(rawUserId);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + passwordSetupTtlMs);
      await db.transaction(async (tx) => {
        await tx
          .delete(verifications)
          .where(
            and(eq(verifications.value, userId), like(verifications.identifier, `${setupPrefix}%`)),
          );
        await tx
          .insert(verifications)
          .values({ identifier: setupIdentifier(token), value: userId, expiresAt });
      });
      return { token, expiresAt };
    },
    async setPassword(token, rawPassword) {
      const password = passwordSchema.safeParse(rawPassword);
      if (!password.success || token.length === 0 || token.length > 200) return { ok: false };
      const validToken = and(
        eq(verifications.identifier, setupIdentifier(token)),
        gt(verifications.expiresAt, new Date()),
      );
      // Hashing is deliberately slow: check the token first, so a guessed token costs no hash.
      const [known] = await db
        .select({ id: verifications.id })
        .from(verifications)
        .where(validToken);
      if (!known) return { ok: false };
      // Better Auth's own hasher, so its sign-in can verify the result.
      const hash = await hashPassword(password.data);
      return db.transaction(async (tx) => {
        // Deleting is what makes the token single-use: two racing requests can't both get it.
        const [used] = await tx
          .delete(verifications)
          .where(validToken)
          .returning({ userId: verifications.value });
        if (!used) return { ok: false } as const;
        const userId = userIdSchema.parse(used.userId);
        await tx
          .insert(accounts)
          .values({ userId, accountId: userId, providerId: "credential", password: hash })
          .onConflictDoUpdate({
            target: [accounts.providerId, accounts.accountId],
            set: { password: hash },
          });
        // A new password ends every session started with the old one.
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        return { ok: true } as const;
      });
    },
    sessions: options.sessions ? createSessionAuth(db, options.sessions) : null,
    close: () => client.end({ timeout: 5 }),
  };
}

function credentialOf(userId: string) {
  return and(
    eq(accounts.userId, userId),
    eq(accounts.providerId, "credential"),
    eq(accounts.accountId, userId),
  );
}

function createSessionAuth(db: ReturnType<typeof drizzle>, options: SessionOptions): SessionAuth {
  const auth = betterAuth({
    secret: options.secret,
    baseURL: options.baseUrl,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    // Email + password only (#46). No sign-up: users are created by `pnpm helpos:init`.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: passwordSchema.minLength ?? 12,
      maxPasswordLength: passwordSchema.maxLength ?? 128,
    },
    session: { expiresIn: 7 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    advanced: {
      cookiePrefix: options.cookiePrefix,
      useSecureCookies: options.baseUrl.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      database: { generateId: () => uuidv7() },
    },
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      log: (level, message) => options.log?.(level, message),
    },
  });

  return {
    async signIn(rawEmail, password, headers) {
      const email = emailSchema.safeParse(rawEmail);
      if (!email.success) return { ok: false };
      try {
        const result = await auth.api.signInEmail({
          body: { email: email.data, password, rememberMe: true },
          headers,
          returnHeaders: true,
        });
        return {
          ok: true,
          userId: result.response.user.id,
          setCookie: result.headers.getSetCookie(),
        };
      } catch (error) {
        // Wrong password, unknown email and malformed input are all just "no".
        if (error instanceof APIError && error.statusCode < 500) return { ok: false };
        throw error;
      }
    },
    async resolveSession(headers) {
      if (!headers.get("cookie")) return null;
      const found = await auth.api.getSession({ headers });
      if (!found) return null;
      return { userId: found.user.id, email: found.user.email };
    },
    async signOut(headers) {
      try {
        const result = await auth.api.signOut({ headers, returnHeaders: true });
        return { setCookie: result.headers.getSetCookie() };
      } catch (error) {
        // No session to end: nothing to clear.
        if (error instanceof APIError && error.statusCode < 500) return { setCookie: [] };
        throw error;
      }
    },
  };
}
