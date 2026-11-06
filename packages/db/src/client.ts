import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
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
  /** Checks the database answers a trivial query. Never throws: failures come back as a result. */
  ping(): Promise<PingResult>;
  close(): Promise<void>;
}

export type PingResult = { ok: true } | { ok: false; error: unknown };

const tenantIdSchema = z.uuid();

export function createDatabase(url: string): Database {
  const client = postgres(url, { max: 10, connect_timeout: 5, onnotice: () => {} });
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
