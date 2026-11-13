// `pnpm dev`: start local services, apply migrations, then run the server and the dashboard in
// watch mode. The dashboard (http://localhost:5180) forwards API calls to the server (:3000).
// Plain Node (no shell syntax) so it behaves the same on Windows, macOS and Linux.
// In a git worktree it uses its own database and ports (scripts/worktree-env.mjs), so parallel
// agent threads don't collide, and it seeds demo data on the first run.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envMessages, isWorktree, linkEnv, mainCheckoutDir } from "./worktree.mjs";
import {
  databaseSetupSql,
  isolatedEnv,
  isolationFor,
  needsSeed,
  parseEnv,
} from "./worktree-env.mjs";

// Commands are fixed strings (no user input). They run through the shell so Windows finds
// `pnpm.cmd`; passing one string avoids Node's unescaped-args warning (DEP0190).
function run(command, env = process.env) {
  const result = spawnSync(command, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) {
    process.stderr.write(`\n✖ "${command}" failed.\n`);
    if (command.startsWith("docker")) process.stderr.write("  Is Docker running?\n");
    process.exit(result.status ?? 1);
  }
}

const worktree = isWorktree();
if (worktree) {
  const linked = linkEnv();
  if (linked !== "exists") process.stdout.write(`${envMessages[linked]}\n`);
}

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  process.stdout.write("Created .env from .env.example\n");
}

// The example ships no encryption key, so nobody reuses a published one. Give this checkout a
// random key of its own when it has none. Only that one line is written; the key isn't printed.
const env = readFileSync(".env", "utf8");
if (!/^HELPOS_ENCRYPTION_KEY=\S+/m.test(env)) {
  const line = `HELPOS_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`;
  const updated = /^HELPOS_ENCRYPTION_KEY=.*$/m.test(env)
    ? env.replace(/^HELPOS_ENCRYPTION_KEY=.*$/m, line)
    : `${env.trimEnd()}\n${line}\n`;
  writeFileSync(".env", updated);
  process.stdout.write("Added a random HELPOS_ENCRYPTION_KEY to .env\n");
}

const isolation = isolationFor(process.cwd(), { isWorktree: worktree });
const overrides = isolatedEnv(
  // Shell-exported values reach the children too, so they are checked and rewritten as well.
  { ...parseEnv(readFileSync(".env", "utf8")), ...process.env },
  isolation,
);
if (!overrides.ok) {
  process.stderr.write(
    `\n✖ ${overrides.reason}. A worktree only ever uses its own local database.\n`,
  );
  process.exit(1);
}
// Set in the children's environment, these beat the shared .env (--env-file never overrides).
const childEnv = { ...process.env, ...overrides.env };

// Every checkout shares one compose project. Worktrees use the main checkout's compose file, so
// its bind mounts don't change and Docker doesn't recreate the shared Postgres container.
const composeFile = worktree ? join(mainCheckoutDir(), "docker-compose.yml") : "docker-compose.yml";
const initSql = new URL("../docker/postgres/init.sql", import.meta.url);
run(`docker compose -f "${composeFile}" up -d --wait`);
let created = false;
if (isolation.isolated) {
  created = ensureDatabase(isolation.dbName);
  process.stdout.write(`Worktree database: ${isolation.dbName}\n`);
}
run("pnpm --filter @helpos/db migrate", childEnv);

// A fresh worktree gets demo data: an empty database is a bad test. The seed is safe to rerun,
// so the marker only saves time; delete .helpos/seeded to seed again.
// It names the database it was written for, so a new database (moved folder, dropped
// database) is seeded again, and so is any database this run had to create.
const seeded = ".helpos/seeded";
const marker = existsSync(seeded) ? readFileSync(seeded, "utf8") : undefined;
if (needsSeed({ isolation, created, marker })) {
  run("pnpm db:seed", childEnv);
  mkdirSync(".helpos", { recursive: true });
  writeFileSync(seeded, `${isolation.dbName}\n`);
}

process.stdout.write("Mailpit (caught emails): http://localhost:8025\n");
process.stdout.write(`API: http://localhost:${isolation.serverPort}\n`);
process.stdout.write(`Dashboard: http://localhost:${isolation.webPort}\n`);
const children = [
  spawn("pnpm --filter @helpos/server dev", { stdio: "inherit", shell: true, env: childEnv }),
  spawn(`pnpm --filter @helpos/web dev --port ${isolation.webPort}`, {
    stdio: "inherit",
    shell: true,
    env: childEnv,
  }),
];
// One stopping stops the other. Killed by a signal means `code` is null: report failure.
for (const child of children) {
  child.on("exit", (code, signal) => {
    for (const other of children) if (other !== child) other.kill();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Creates this worktree's database in the shared Postgres container, with the same schemas and
// grants as docker/postgres/init.sql gives the default one. The name is our own hex digest, so
// it is safe to put in SQL.
function ensureDatabase(name) {
  const psql = (args, input) =>
    spawnSync(
      "docker",
      ["compose", "-f", composeFile, "exec", "-T", "postgres", "psql", "-U", "postgres", ...args],
      {
        encoding: "utf8",
        input,
      },
    );
  const exists = psql(["-tAc", `SELECT 1 FROM pg_database WHERE datname = '${name}'`]);
  if (exists.status !== 0) fail(`checking for database ${name}`, exists.stderr);
  if (exists.stdout.trim() === "1") return false;
  const setupSql = databaseSetupSql(readFileSync(initSql, "utf8"));
  const create = psql(["-c", `CREATE DATABASE ${name} OWNER helpos_owner`]);
  if (create.status !== 0) fail(`creating database ${name}`, create.stderr);
  const setup = psql(["-v", "ON_ERROR_STOP=1", "-d", name], setupSql);
  if (setup.status !== 0) {
    // Drop the half-made database, so the next run creates it again instead of skipping it.
    psql(["-c", `DROP DATABASE IF EXISTS ${name}`]);
    fail(`setting up database ${name}`, setup.stderr);
  }
  process.stdout.write(`Created database ${name}\n`);
  return true;
}

function fail(what, detail) {
  process.stderr.write(`\n✖ Failed ${what}:\n${detail}\n`);
  process.exit(1);
}
