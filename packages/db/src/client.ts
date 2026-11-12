import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import type { ApiTokenScope } from "./schema.ts";
import * as schema from "./schema.ts";

type Db = PostgresJsDatabase<typeof schema>;

/** A transaction scoped to one tenant. Row-level security filters every query in it. */
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface Database {
  /**
   * The only way to reach tenant data (ADR 0003). Runs `fn` in a transaction with
   * `app.tenant_id` set transaction-locally, so it never leaks to the next pooled request.
   */
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /**
   * Finds which workspace a support address belongs to, before any tenant is known.
   * Sees only the one mailbox row whose address is passed in (policy `route_by_address`).
   */
  resolveMailbox(address: string): Promise<MailboxRoute | null>;
  /**
   * Finds the agent token with this SHA-256 hash, before any tenant is known. Sees only the
   * one row whose hash is passed in (policy `resolve_by_token_hash`). Revoked tokens are
   * returned too, so the caller decides; null when no token has this hash.
   */
  resolveApiToken(tokenHash: string): Promise<ApiTokenRecord | null>;
  /**
   * Lists the workspaces a user belongs to, across tenants (ADR 0009 §1, policy
   * `own_memberships`). Read-only. Oldest first, so "the user's first workspace" is stable.
   */
  listMemberships(userId: string): Promise<MembershipSummary[]>;
  /** Checks the database answers a trivial query. Never throws: failures come back as a result. */
  ping(): Promise<PingResult>;
  close(): Promise<void>;
}

interface MailboxRoute {
  tenantId: string;
  mailboxId: string;
}

export interface ApiTokenRecord {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  scopes: ApiTokenScope[];
  revokedAt: Date | null;
}

interface MembershipSummary {
  tenantId: string;
  role: schema.WorkspaceRole;
}

type PingResult = { ok: true } | { ok: false; error: unknown };

const tenantIdSchema = z.uuid();
const addressSchema = z.string().trim().toLowerCase().min(3).max(320);
const tokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export function createDatabase(urlOrClient: string | postgres.Sql): Database {
  const client =
    typeof urlOrClient === "string"
      ? postgres(urlOrClient, { max: 10, connect_timeout: 5, onnotice: () => {} })
      : urlOrClient;
  const db = drizzle(client, { schema });

  return {
    async withTenant(tenantId, fn) {
      // Validate before it reaches the DB: a bad id must fail loudly, not match nothing.
      const id = tenantIdSchema.parse(tenantId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${id}, true)`);
        return fn(tx);
      });
    },
    async resolveMailbox(rawAddress) {
      const parsed = addressSchema.safeParse(rawAddress);
      if (!parsed.success) return null;
      const address = parsed.data;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.mailbox_address', ${address}, true)`);
        const rows = await tx
          .select({ tenantId: schema.mailboxes.tenantId, mailboxId: schema.mailboxes.id })
          .from(schema.mailboxes)
          .where(eq(schema.mailboxes.address, address));
        return rows[0] ?? null;
      });
    },
    async resolveApiToken(rawHash) {
      const parsed = tokenHashSchema.safeParse(rawHash);
      if (!parsed.success) return null;
      const tokenHash = parsed.data;
      const t = schema.apiTokens;
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.token_hash', ${tokenHash}, true)`);
        const rows = await tx
          .select({
            id: t.id,
            tenantId: t.tenantId,
            name: t.name,
            tokenHash: t.tokenHash,
            scopes: t.scopes,
            revokedAt: t.revokedAt,
          })
          .from(t)
          .where(eq(t.tokenHash, tokenHash));
        return rows[0] ?? null;
      });
    },
    async listMemberships(userId) {
      const id = tenantIdSchema.parse(userId);
      return db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${id}, true)`);
        return tx
          .select({ tenantId: schema.memberships.tenantId, role: schema.memberships.role })
          .from(schema.memberships)
          .where(eq(schema.memberships.userId, id))
          .orderBy(asc(schema.memberships.createdAt), asc(schema.memberships.id));
      });
    },
    async ping() {
      try {
        await db.execute(sql`select 1`);
        return { ok: true };
      } catch (error) {
        // Health checks report "down" instead of crashing; the caller logs the error.
        return { ok: false, error };
      }
    },
    close: () => client.end({ timeout: 5 }),
  };
}
