import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { installJobs } from "./jobs.ts";
import { runMigrations } from "./migrate.ts";

const initSql = fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url));

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** URL for the app role (no BYPASSRLS), same as the server uses. */
  appUrl: string;
  ownerUrl: string;
  /** URL for the auth role, the only one that can use the `auth` schema (ADR 0009). */
  authUrl: string;
  /** URL for the jobs role, owner of the `pgboss` schema. */
  jobsUrl: string;
}

/**
 * Starts a throwaway Postgres with the same image, roles and migrations as local dev,
 * so tests exercise real SQL and real RLS (ADR 0005).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withCopyFilesToContainer([{ source: initSql, target: "/docker-entrypoint-initdb.d/init.sql" }])
    // A throwaway database: durability only costs disk writes, and small buffers let several
    // run at once in Docker Desktop's default VM without it running out of memory.
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "shared_buffers=32MB",
    ])
    .start();
  const hostPort = `${container.getHost()}:${container.getPort()}`;
  const ownerUrl = `postgres://helpos_owner:helpos_owner@${hostPort}/helpos`;
  const jobsUrl = `postgres://helpos_jobs:helpos_jobs@${hostPort}/helpos`;
  try {
    await runMigrations(ownerUrl);
    await installJobs(jobsUrl);
  } catch (error) {
    // The test file never gets the container to stop, so stop it here rather than leave it
    // running until Testcontainers' reaper notices.
    await container.stop();
    throw error;
  }
  return {
    container,
    ownerUrl,
    appUrl: `postgres://helpos_app:helpos_app@${hostPort}/helpos`,
    authUrl: `postgres://helpos_auth:helpos_auth@${hostPort}/helpos`,
    jobsUrl,
  };
}
