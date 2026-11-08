// Per-worktree isolation for parallel agent threads. Every git worktree gets its own database and
// ports, derived from its path, so two threads can run `pnpm dev` at once. The same path always
// gives the same values, so restarts find their data again. The main checkout keeps the defaults.
// Pure (no I/O), so it is tested without Docker.
import { createHash } from "node:crypto";

export const defaults = { dbName: "helpos", serverPort: 3000, webPort: 5180 };

// 1..999. Ports 20001..20999 (server) and 21001..21999 (dashboard) stay clear of the defaults
// and of each other.
const slots = 999;

/** Same folder, same key: Windows paths are case-insensitive and may use either slash. */
export function normalizePath(path, platform = process.platform) {
  const forward = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? forward.toLowerCase() : forward;
}

export function isolationFor(path, { isWorktree, platform = process.platform }) {
  if (!isWorktree) return { ...defaults, isolated: false };
  const digest = createHash("sha256").update(normalizePath(path, platform)).digest();
  const slot = (digest.readUInt32BE(0) % slots) + 1;
  return {
    isolated: true,
    dbName: `helpos_wt_${digest.subarray(0, 4).toString("hex")}`,
    serverPort: 20000 + slot,
    webPort: 21000 + slot,
  };
}

const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const dbVars = [
  "HELPOS_DATABASE_URL",
  "HELPOS_DATABASE_OWNER_URL",
  "HELPOS_DATABASE_AUTH_URL",
  "HELPOS_DATABASE_JOBS_URL",
];

/**
 * The environment overrides for this checkout. Node's --env-file never overrides a variable that
 * is already set, so passing these to child processes beats the shared .env.
 * Refuses a worktree whose .env points at a non-local database: a worktree must never write to
 * a shared or production database.
 */
export function isolatedEnv(env, isolation) {
  if (!isolation.isolated) return { ok: true, env: {} };
  const out = {};
  for (const name of dbVars) {
    const raw = env[name];
    if (!raw) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: `${name} is not a valid URL` };
    }
    if (!localHosts.has(url.hostname.toLowerCase()) || url.searchParams.has("host")) {
      return { ok: false, reason: `${name} points at a non-local database` };
    }
    url.pathname = `/${isolation.dbName}`;
    out[name] = url.toString();
  }
  out.HELPOS_PORT = String(isolation.serverPort);
  out.HELPOS_PUBLIC_URL = `http://localhost:${isolation.webPort}`;
  out.HELPOS_API_URL = `http://localhost:${isolation.serverPort}`;
  return { ok: true, env: out };
}

/** Parses the KEY=value lines of a .env file. Enough for our own files; no quoting rules. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Per-database setup that docker/postgres/init.sql does for the default `helpos` database. */
export function databaseSetupSql() {
  return `CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO helpos_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO helpos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helpos_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE helpos_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO helpos_app;
CREATE SCHEMA pgboss AUTHORIZATION helpos_jobs;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
CREATE SCHEMA jobs_api AUTHORIZATION helpos_jobs;
REVOKE ALL ON SCHEMA jobs_api FROM PUBLIC;
GRANT USAGE ON SCHEMA jobs_api TO helpos_app;
`;
}
