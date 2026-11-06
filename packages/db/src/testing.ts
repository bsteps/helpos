import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runMigrations } from "./migrate.ts";

const initSql = fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url));

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** URL for the app role (no BYPASSRLS), same as the server uses. */
  appUrl: string;
  ownerUrl: string;
}

/**
 * Starts a throwaway Postgres with the same image, roles and migrations as local dev,
 * so tests exercise real SQL and real RLS (ADR 0005).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withCopyFilesToContainer([{ source: initSql, target: "/docker-entrypoint-initdb.d/init.sql" }])
    .start();
  const hostPort = `${container.getHost()}:${container.getPort()}`;
  const ownerUrl = `postgres://helpos_owner:helpos_owner@${hostPort}/helpos`;
  await runMigrations(ownerUrl);
  return { container, ownerUrl, appUrl: `postgres://helpos_app:helpos_app@${hostPort}/helpos` };
}
