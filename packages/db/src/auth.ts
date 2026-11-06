import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { users } from "./schema.ts";

/**
 * The only code that connects as the `helpos_auth` role (ADR 0009 §1). The client stays in
 * this module; the rest of the app gets these narrow functions and nothing else.
 */
export interface AuthStore {
  /** Returns the user with this email, creating it if needed. Idempotent. */
  ensureUser(email: string): Promise<{ id: string; email: string }>;
  close(): Promise<void>;
}

const emailSchema = z.email().trim().toLowerCase();

export function createAuthStore(authUrl: string): AuthStore {
  const client = postgres(authUrl, { max: 2, connect_timeout: 5, onnotice: () => {} });
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
    close: () => client.end({ timeout: 5 }),
  };
}
