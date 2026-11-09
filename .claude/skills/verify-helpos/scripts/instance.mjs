// The one place that knows where this checkout's HelpOS instance lives. Ports and database come
// from scripts/worktree-env.mjs, the same code `pnpm dev` uses, so they can't drift apart.
//   node .claude/skills/verify-helpos/scripts/instance.mjs            print the instance as JSON
//   node .claude/skills/verify-helpos/scripts/instance.mjs run -- <command…>
//                                         run a command against this checkout's database and ports
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const evidenceRoot = join(repoRoot, ".helpos", "verify");
/** Written by launch.mjs: the pids it started. cleanup.mjs stops nothing else. */
export const launchRecord = join(evidenceRoot, "instance.json");
/**
 * Live credentials the helpers keep between runs (the owner's session, the last minted token).
 * Not in the evidence folder: that one is meant to be attached as proof.
 */
export const stateRoot = join(repoRoot, ".helpos", "verify-state");

export function launchedPids() {
  if (!existsSync(launchRecord)) return new Set();
  // Cut short (launch killed while writing): treat it as no record, so nothing is stopped by it.
  try {
    return new Set(JSON.parse(readFileSync(launchRecord, "utf8")).pids);
  } catch {
    return new Set();
  }
}

const { isWorktree } = await import(pathToFileURL(join(repoRoot, "scripts/worktree.mjs")).href);
const { isLocalDatabaseUrl, isolationFor, isolatedEnv, parseEnv } = await import(
  pathToFileURL(join(repoRoot, "scripts/worktree-env.mjs")).href
);

/** The product's name for messages, from @helpos/brand like the app's own. */
export const { brand } = await import(
  pathToFileURL(join(repoRoot, "packages/brand/src/index.ts")).href
);

// Every helper imports this file, so this one place gives all their requests a time limit:
// a server that accepts a connection and never answers must fail the step, not hang it.
const plainFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  // A caller with its own signal (a 2s probe) keeps it, and its own TimeoutError.
  if (init.signal) return plainFetch(url, init);
  try {
    return await plainFetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    if (error?.name !== "TimeoutError") throw error;
    throw new Error(`${init.method ?? "GET"} ${url} didn't answer within 30 seconds`);
  }
};

/** Demo tokens from apps/server/src/seed/demo-data.ts. They are public by design: local DBs only. */
export const seed = {
  northwind: {
    mailbox: "support@northwind-cycles.test",
    owner: "maya.okafor@northwind-cycles.test",
    ownerPassword: "northwind demo password",
  },
};

/**
 * Imports one of the server's own .ts files, so the helpers share its seed data and scopes
 * instead of copying them. Needs Node's built-in type stripping (Node 24, as package.json says).
 */
async function serverModule(path) {
  if (!process.features.typescript) {
    quit(
      1,
      `The helpers import apps/server's .ts files: use Node 24 (this is ${process.version}).`,
    );
  }
  return import(pathToFileURL(join(repoRoot, "apps/server/src", path)).href);
}

export async function seedToken(name) {
  return (await serverModule("seed/demo-data.ts")).seedToken(name);
}

/** The scopes a seed token holds, from the seed data itself: `northwind:triage-bot`. */
export async function seedTokenScopes(name) {
  const [workspace, token] = name.split(":");
  const { buildDemoData } = await serverModule("seed/demo-data.ts");
  const tenant = buildDemoData().tenants.find((t) => t.key === workspace);
  return tenant?.tokens.find((t) => t.name === token)?.scopes ?? [];
}

/** Every scope the API knows, which an owner holds. */
export async function allScopes() {
  return (await serverModule("auth/principal.ts")).scopes;
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
  // The shell wins over .env, as it does for `node --env-file`, which is how the server and the
  // children read .env: so this merge is what they will connect to.
  const config = { ...dotenv, ...process.env };
  const overrides = isolatedEnv(config, isolation);
  if (!overrides.ok) throw new Error(`Refusing to drive this checkout: ${overrides.reason}`);
  // In a worktree, isolatedEnv() checked these. The main checkout uses .env as written, and the
  // helpers set a known demo password and seed tokens, so it must be a local database too, and
  // named: unset, the server would fall back to whatever its driver defaults to.
  if (!config.HELPOS_DATABASE_URL) {
    throw new Error("Refusing to drive this checkout: HELPOS_DATABASE_URL is not set");
  }
  const remote = Object.entries(config).find(
    ([name, value]) => /^HELPOS_DATABASE_\w*URL$/.test(name) && value && !isLocalDatabaseUrl(value),
  );
  if (remote) {
    throw new Error(`Refusing to drive this checkout: ${remote[0]} is not a local database`);
  }
  return {
    repoRoot,
    // A worktree's own database; in the main checkout, whichever one .env or the shell names.
    dbName: isolation.dbName ?? new URL(config.HELPOS_DATABASE_URL).pathname.slice(1),
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
export const lastFile = join(stateRoot, "last.json");
const seededMarker = join(repoRoot, ".helpos", "seeded");
export function lastCreated() {
  if (!existsSync(lastFile)) return {};
  // Saved before the database was last seeded (a reset drops it and seeds again): those IDs
  // are gone, so a stale {ticket} must not turn every call into a 404.
  if (existsSync(seededMarker) && statSync(lastFile).mtimeMs < statSync(seededMarker).mtimeMs) {
    return {};
  }
  // Cut short (a helper killed while writing): no saved values, rather than every helper failing.
  try {
    return JSON.parse(readFileSync(lastFile, "utf8"));
  } catch {
    return {};
  }
}
export function remember(values) {
  mkdirSync(stateRoot, { recursive: true });
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
  const ticket = await getJson(inst, `/v1/tickets/${ticketId}`, headers);
  if (ticket.automated)
    return "the ticket is an automated email (bounce, auto-reply): the AI never drafts for those";
  const usage = await getJson(inst, "/v1/ai-usage", headers);
  if (ticket.aiPausedReason === "daily_budget" || usage.paused) {
    return `today's AI budget is spent (${usage.totalTokens} of ${usage.dailyTokenBudget} tokens), so no draft will be written until midnight UTC`;
  }
  return undefined;
}

/**
 * GETs an API path and returns its JSON. A refusal (401, 404) or a body that isn't JSON stops
 * the script with the status, instead of looking like "nothing yet" or a stack trace.
 */
export async function getJson(inst, path, headers) {
  const res = await fetch(`${inst.apiUrl}${path}`, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    quit(1, `GET ${path} answered ${res.status}, not JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) quit(1, `GET ${path} answered ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/**
 * The Northwind owner's session cookie, or null when the owner can't sign in. Reused while it
 * still works (checked with GET /v1/me), so each helper call doesn't add another session.
 */
export async function ownerCookie(inst) {
  const file = join(stateRoot, "owner-session.txt");
  if (existsSync(file)) {
    const cookie = readFileSync(file, "utf8").trim();
    const me = await fetch(`${inst.apiUrl}/v1/me`, { headers: { cookie } });
    await me.body?.cancel();
    if (me.status === 200) return cookie;
  }
  const res = await fetch(`${inst.apiUrl}/v1/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: inst.webUrl },
    body: JSON.stringify({ email: seed.northwind.owner, password: seed.northwind.ownerPassword }),
  });
  await res.body?.cancel();
  if (res.status !== 204) return null;
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(file, `${cookie}\n`);
  return cookie;
}

/**
 * The value after `flag` in `args`, or undefined when the flag isn't there. A flag with no value
 * after it, or with another flag there instead, stops the script rather than send "--body".
 */
export function flagArg(args, flag, { anyValue = false } = {}) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // A secret can start with dashes; a subject that does is far more likely a forgotten value.
  if (value === undefined || (!anyValue && value.startsWith("--"))) {
    quit(2, `${flag} needs a value after it`);
  }
  return value;
}

/**
 * Runs a command (an array: program, then its arguments) with this checkout's database and
 * ports. No shell, so every argument reaches the program exactly as given: quoting for cmd.exe
 * kept changing `%`, `\` and `"` on Windows. There, node and pnpm (pnpm's own .exe, from
 * npm_execpath) are run directly; anything else isn't supported.
 */
export function runCommand([program, ...args], inst, options = {}) {
  let file = program;
  let prefix = [];
  // Set by pnpm for the scripts it runs: the pnpm that started this one.
  const { npm_execpath: pnpm } = process.env;
  if (program === "node") file = process.execPath;
  else if (program === "pnpm" && pnpm) {
    // pnpm installed with npm is a script for node; pnpm's standalone install is an .exe.
    if (/\.[cm]?js$/.test(pnpm)) [file, prefix] = [process.execPath, [pnpm]];
    else file = pnpm;
  } else if (process.platform === "win32") {
    quit(
      2,
      `app:run runs node or pnpm on Windows, not "${program}", and pnpm only when started ` +
        "through pnpm (pnpm app:run ...).",
    );
  }
  const result = spawnSync(file, [...prefix, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...inst.env },
    ...options,
  });
  // Not found or not runnable: there is no exit code and nothing on stderr to show.
  if (result.error) quit(1, `Couldn't start ${program}: ${result.error.message}`);
  return result;
}

/** Stops a script with a plain answer, not a fetch stack trace, when the app isn't up. */
export async function requireRunning(inst) {
  const up = await fetch(`${inst.apiUrl}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (up) return;
  process.stderr.write(
    `${brand.name} isn't running at ${inst.apiUrl}.\n` +
      "Start it in its own terminal: pnpm app:start\n" +
      "then wait for:                pnpm app:doctor --wait 120\n",
  );
  quit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inst = instance();
  if (process.argv[2] === "run") {
    // An optional `--` right after `run`; one later on belongs to the command itself.
    const args = process.argv.slice(process.argv[3] === "--" ? 4 : 3);
    if (args.length === 0) quit(2, "Usage: instance.mjs run <command>");
    process.exitCode = runCommand(args, inst, { stdio: "inherit" }).status ?? 1;
  } else {
    const { inboundSecret, env, ...shown } = inst;
    process.stdout.write(
      `${JSON.stringify({ ...shown, inboundSecretSet: Boolean(inboundSecret) }, null, 2)}\n`,
    );
  }
}
