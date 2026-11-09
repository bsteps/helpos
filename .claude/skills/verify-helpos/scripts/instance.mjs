// The one place that knows where this checkout's HelpOS instance lives. Ports and database come
// from scripts/worktree-env.mjs, the same code `pnpm dev` uses, so they can't drift apart.
//   node .claude/skills/verify-helpos/scripts/instance.mjs            print the instance as JSON
//   node .claude/skills/verify-helpos/scripts/instance.mjs run -- <command…>
//                                         run a command against this checkout's database and ports
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const evidenceRoot = join(repoRoot, ".helpos", "verify");
/** Written by launch.mjs: the pids it started. cleanup.mjs stops nothing else. */
export const launchRecord = join(evidenceRoot, "instance.json");

export function launchedPids() {
  if (!existsSync(launchRecord)) return new Set();
  return new Set(JSON.parse(readFileSync(launchRecord, "utf8")).pids);
}

const { isWorktree } = await import(pathToFileURL(join(repoRoot, "scripts/worktree.mjs")).href);
const { isolationFor, isolatedEnv, parseEnv } = await import(
  pathToFileURL(join(repoRoot, "scripts/worktree-env.mjs")).href
);

/** Demo tokens from apps/server/src/seed/demo-data.ts. They are public by design: local DBs only. */
export const seed = {
  northwind: {
    mailbox: "support@northwind-cycles.test",
    owner: "maya.okafor@northwind-cycles.test",
    ownerPassword: "northwind demo password",
  },
};

export async function seedToken(name) {
  const { seedToken: make } = await import(
    pathToFileURL(join(repoRoot, "apps/server/src/seed/demo-data.ts")).href
  );
  return make(name);
}

/** Embedding settings for a local Ollama, used only when the shared .env sets none. */
export const ollamaEmbedding = {
  AI_EMBEDDING_PROVIDER: "openai",
  AI_EMBEDDING_MODEL: "qwen3-embedding:0.6b",
  AI_EMBEDDING_BASE_URL: "http://localhost:11434/v1",
};

export function instance() {
  const dotenvPath = join(repoRoot, ".env");
  const dotenv = existsSync(dotenvPath) ? parseEnv(readFileSync(dotenvPath, "utf8")) : {};
  const isolation = isolationFor(repoRoot, { isWorktree: isWorktree(repoRoot) });
  // The shell wins over .env, as it does for `node --env-file`.
  const config = { ...dotenv, ...process.env };
  const overrides = isolatedEnv(config, isolation);
  if (!overrides.ok) throw new Error(`Refusing to drive this checkout: ${overrides.reason}`);
  return {
    repoRoot,
    dbName: isolation.dbName,
    apiUrl: `http://localhost:${isolation.serverPort}`,
    webUrl: `http://localhost:${isolation.webPort}`,
    mailpitUrl: "http://localhost:8025",
    inboundSecret: config.HELPOS_INBOUND_SECRET,
    embeddingsInEnv: Boolean(config.AI_EMBEDDING_PROVIDER),
    env: overrides.env,
  };
}

/** Stops a script with a plain answer, not a fetch stack trace, when the app isn't up. */
export async function requireRunning(inst) {
  const up = await fetch(`${inst.apiUrl}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (up) return;
  process.stderr.write(
    `HelpOS isn't running at ${inst.apiUrl}.\n` +
      "Start it in its own terminal: node .claude/skills/verify-helpos/scripts/launch.mjs\n" +
      "then wait for:                node .claude/skills/verify-helpos/scripts/doctor.mjs --wait 120\n",
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inst = instance();
  if (process.argv[2] === "run") {
    const command = process.argv.slice(process.argv.indexOf("--") + 1).join(" ");
    if (!command) {
      process.stderr.write("Usage: instance.mjs run -- <command>\n");
      process.exit(2);
    }
    const result = spawnSync(command, {
      stdio: "inherit",
      shell: true,
      cwd: repoRoot,
      env: { ...process.env, ...inst.env },
    });
    process.exit(result.status ?? 1);
  }
  const { inboundSecret, env, ...shown } = inst;
  process.stdout.write(
    `${JSON.stringify({ ...shown, inboundSecretSet: Boolean(inboundSecret) }, null, 2)}\n`,
  );
}
