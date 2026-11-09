import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { installJobs } from "./jobs.ts";
import { runMigrations } from "./migrate.ts";

const initSql = fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url));

/** Set by the test global setup: the shared Postgres that test files make their databases in. */
const sharedServerEnv = "HELPOS_TEST_POSTGRES";

export interface TestDatabase {
  /** URL for the app role (no BYPASSRLS), same as the server uses. */
  appUrl: string;
  ownerUrl: string;
  /** URL for the auth role, the only one that can use the `auth` schema (ADR 0009). */
  authUrl: string;
  /** URL for the jobs role, owner of the `pgboss` schema. */
  jobsUrl: string;
  /** Drops the database, or stops its container when it has one of its own. */
  stop(): Promise<void>;
}

function urls(hostPort: string, database: string) {
  const url = (role: string) => `postgres://${role}:${role}@${hostPort}/${database}`;
  return {
    ownerUrl: url("helpos_owner"),
    appUrl: url("helpos_app"),
    authUrl: url("helpos_auth"),
    jobsUrl: url("helpos_jobs"),
  };
}

/**
 * A throwaway Postgres with the same image, roles and migrations as local dev, so tests
 * exercise real SQL and real RLS (ADR 0005). Its migrated `helpos` database is the template
 * that each test database is copied from.
 */
async function startServer(): Promise<{ container: StartedPostgreSqlContainer; adminUrl: string }> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withCopyFilesToContainer([{ source: initSql, target: "/docker-entrypoint-initdb.d/init.sql" }])
    // A throwaway database: durability only costs disk writes.
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "shared_buffers=64MB",
      "-c",
      "max_connections=300",
    ])
    .start();
  const hostPort = hostPortOf(container);
  const { ownerUrl, jobsUrl } = urls(hostPort, "helpos");
  try {
    await runMigrations(ownerUrl);
    await installJobs(jobsUrl);
  } catch (error) {
    // Nothing else gets the container to stop, so stop it here rather than leave it running
    // until Testcontainers' reaper notices.
    await container.stop();
    throw error;
  }
  const admin = `${encodeURIComponent(container.getUsername())}:${encodeURIComponent(container.getPassword())}`;
  return { container, adminUrl: `postgres://${admin}@${hostPort}/postgres` };
}

/**
 * A test container's host, as IPv4. Testcontainers says `localhost`, which Node tries as `::1`
 * first, and Docker Desktop's IPv6 port forwarding stalls new connections while other
 * containers are busy: half of 50 Postgres connections hit CONNECT_TIMEOUT, and SMTP
 * connections to Mailpit waited 15 s, where 127.0.0.1 took under 150 ms for both.
 */
export function containerHost(container: { getHost(): string }): string {
  const host = container.getHost();
  return host === "localhost" ? "127.0.0.1" : host;
}

function hostPortOf(container: StartedPostgreSqlContainer): string {
  return `${containerHost(container)}:${container.getPort()}`;
}

/**
 * Vitest global setup: starts one Postgres for the whole run, so test files don't each
 * start a container. Starting many at once overloads Docker, and their databases time out.
 */
export async function setup(): Promise<() => Promise<void>> {
  const { container, adminUrl } = await startServer();
  process.env[sharedServerEnv] = adminUrl;
  return async () => {
    await container.stop();
  };
}

/**
 * A fresh, migrated database of its own for one test file. In a test run it is a copy of the
 * shared server's template, which takes a fraction of a second. Outside one (the e2e server),
 * it starts its own container.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env[sharedServerEnv];
  if (!adminUrl) {
    const { container } = await startServer();
    return {
      ...urls(hostPortOf(container), "helpos"),
      stop: async () => {
        await container.stop();
      },
    };
  }
  const database = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${database} template helpos owner helpos_owner`);
  } finally {
    await admin.end();
  }
  return {
    ...urls(new URL(adminUrl).host, database),
    stop: async () => {
      const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        // FORCE: a test that forgot to close a pool must not leave its database behind.
        await sql.unsafe(`drop database if exists ${database} with (force)`);
      } finally {
        await sql.end();
      }
    },
  };
}
