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

/** Whether a Postgres URL points at this machine (not a remote host, nor a `?host=` override). */
export function isLocalDatabaseUrl(raw) {
  try {
    return isLocalUrl(new URL(raw));
  } catch {
    return false;
  }
}

function isLocalUrl(url) {
  // hostaddr wins over the host name in libpq-style clients, so any value is a way around this.
  if (url.searchParams.has("hostaddr")) return false;
  const host = url.searchParams.get("host");
  // postgres:///db?host=/var/run/postgresql is a Unix socket on this machine: local too.
  if (url.hostname === "" && host?.startsWith("/")) return true;
  return localHosts.has(url.hostname.toLowerCase()) && host === null;
}

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
    // Unset, a variable would fall back to whatever the app or driver defaults to, outside this
    // worktree's own database. The auth URL alone is optional for the server.
    if (!raw) {
      if (name === "HELPOS_DATABASE_AUTH_URL") continue;
      return { ok: false, reason: `${name} is not set` };
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: `${name} is not a valid URL` };
    }
    if (!isLocalUrl(url)) {
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

/**
 * Whether `pnpm dev` should seed: only in a worktree, when this run created its database (say
 * after `docker compose down -v`) or the seeded marker doesn't name this database.
 */
export function needsSeed({ isolation, created, marker }) {
  if (!isolation.isolated) return false;
  return created || marker?.trim() !== isolation.dbName;
}

// Node's own .env parser, so values read here match what `--env-file` gives the children.
export { parseEnv } from "node:util";

/**
 * Per-database setup: the part of docker/postgres/init.sql after it connects to the default
 * `helpos` database. The roles before it already exist in the shared container.
 */
export function databaseSetupSql(initSql) {
  const [, perDatabase] = initSql.split(/^\\connect helpos$/m);
  if (perDatabase === undefined) throw new Error("init.sql has no `\\connect helpos` line");
  return perDatabase;
}
