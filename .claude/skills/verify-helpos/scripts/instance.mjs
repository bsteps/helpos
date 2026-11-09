// The one place that knows where this checkout's HelpOS instance lives. Ports and database come
// from scripts/worktree-env.mjs, the same code `pnpm dev` uses, so they can't drift apart.
//   node .claude/skills/verify-helpos/scripts/instance.mjs            print the instance as JSON
//   node .claude/skills/verify-helpos/scripts/instance.mjs run -- <command…>
//                                         run a command against this checkout's database and ports
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    aiConfigured: Boolean(config.AI_PROVIDER && config.AI_MODEL && config.AI_API_KEY),
    encryptionKeySet: Boolean(config.HELPOS_ENCRYPTION_KEY),
    shadowOffAllowed: config.HELPOS_ALLOW_SHADOW_MODE_OFF === "true",
    env: overrides.env,
  };
}

/**
 * The last ticket, token and knowledge source the scripts created, so a person testing by hand
 * writes `{ticket}` instead of copying IDs between commands.
 */
const lastFile = join(evidenceRoot, "last.json");
export function lastCreated() {
  return existsSync(lastFile) ? JSON.parse(readFileSync(lastFile, "utf8")) : {};
}
export function remember(values) {
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(lastFile, `${JSON.stringify({ ...lastCreated(), ...values }, null, 2)}\n`);
  for (const [k, v] of Object.entries(values)) {
    process.stderr.write(`(saved {${k}} = ${k === "token" ? `${v.slice(0, 8)}…` : v})\n`);
  }
}

/**
 * Stops the script with this exit code. Never process.exit(): exiting while fetch's sockets are
 * closing crashes libuv on Windows ("Assertion failed: UV_HANDLE_CLOSING", exit code 127).
 * The thrown Quit is swallowed below and Node then exits normally with the code.
 */
class Quit extends Error {}
/** Whether `error` is quit() stopping the script: rethrow it, never report it as a failure. */
export const isQuit = (error) => error instanceof Quit;
process.on("uncaughtException", (error) => {
  if (error instanceof Quit) return;
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
export function quit(code, message) {
  if (message) process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exitCode = code;
  throw new Quit();
}

/**
 * Why a ticket will never get an AI draft, or undefined while one may still come. Lets the
 * scripts that wait for a draft stop at once with the reason instead of timing out.
 */
export async function whyNoDraft(inst, ticketId, token) {
  const headers = { authorization: `Bearer ${token}` };
  const ticket = await (await fetch(`${inst.apiUrl}/v1/tickets/${ticketId}`, { headers })).json();
  if (ticket.automated)
    return "the ticket is an automated email (bounce, auto-reply): the AI never drafts for those";
  const usage = await (await fetch(`${inst.apiUrl}/v1/ai-usage`, { headers })).json();
  if (ticket.aiPausedReason === "daily_budget" || usage.paused) {
    return `today's AI budget is spent (${usage.totalTokens} of ${usage.dailyTokenBudget} tokens), so no draft will be written until midnight UTC`;
  }
  return undefined;
}

/** Stops a script with a plain answer, not a fetch stack trace, when the app isn't up. */
export async function requireRunning(inst) {
  const up = await fetch(`${inst.apiUrl}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (up) return;
  process.stderr.write(
    `HelpOS isn't running at ${inst.apiUrl}.\n` +
      "Start it in its own terminal: pnpm app:start\n" +
      "then wait for:                pnpm app:doctor --wait 120\n",
  );
  quit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inst = instance();
  if (process.argv[2] === "run") {
    // The command runs through a shell (Windows needs one to find pnpm.cmd), so each argument is
    // quoted again: `--workspace "Northwind Cycles"` must stay one argument.
    const quote = (arg) =>
      /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
    const command = process.argv
      .slice(process.argv.includes("--") ? process.argv.indexOf("--") + 1 : 3)
      .map(quote)
      .join(" ");
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
    process.exitCode = result.status ?? 1;
  } else {
    const { inboundSecret, env, ...shown } = inst;
    process.stdout.write(
      `${JSON.stringify({ ...shown, inboundSecretSet: Boolean(inboundSecret) }, null, 2)}\n`,
    );
  }
}
