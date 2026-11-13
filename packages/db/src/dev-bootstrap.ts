import { fileURLToPath } from "node:url";
import type { PostgreSqlContainer } from "@testcontainers/postgresql";

const initSql = fileURLToPath(new URL("../../../docker/postgres/init.sql", import.meta.url));

export function withDevBootstrap(container: PostgreSqlContainer): PostgreSqlContainer {
  return container
    .withCopyFilesToContainer([{ source: initSql, target: "/docker-entrypoint-initdb.d/init.sql" }])
    .withEnvironment({
      HELPOS_OWNER_DB_PASSWORD: "helpos_owner",
      HELPOS_APP_DB_PASSWORD: "helpos_app",
      HELPOS_AUTH_DB_PASSWORD: "helpos_auth",
      HELPOS_JOBS_DB_PASSWORD: "helpos_jobs",
    });
}
