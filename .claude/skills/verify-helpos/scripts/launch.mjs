// Starts `pnpm dev` for this checkout and stays in the foreground: run it as a background task.
// Adds local Ollama embeddings when Ollama answers and .env configures none, so knowledge
// sources get embedded instead of waiting in the queue.
//   node .claude/skills/verify-helpos/scripts/launch.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  evidenceRoot,
  instance,
  launchRecord,
  ollamaEmbedding,
  quit,
  repoRoot,
} from "./instance.mjs";
import { descendsFrom, helposChain, listeners } from "./processes.mjs";

const inst = instance();
const ports = [inst.apiUrl, inst.webUrl].map((u) => Number(new URL(u).port));
// pnpm dev would fail to bind, and this launch would then record someone else's processes.
for (const port of ports) {
  const [held] = listeners(port);
  if (held) {
    quit(
      1,
      `port ${port} is already held by pid ${held.pid}: ${held.cmd.slice(0, 100)}\n` +
        "Is HelpOS already running? Check with pnpm app:doctor; stop it with pnpm app:stop.",
    );
  }
}
const env = { ...process.env };
if (!inst.embeddingsInEnv) {
  const ollama = await fetch("http://localhost:11434/api/tags", {
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (ollama) {
    Object.assign(env, ollamaEmbedding);
    process.stdout.write(
      `verify-helpos: embeddings via local Ollama (${ollamaEmbedding.AI_EMBEDDING_MODEL})\n`,
    );
  } else {
    process.stdout.write("verify-helpos: no embeddings (Ollama not running, none in .env)\n");
  }
}
// Hand tests and selftest runs write many drafts (a selftest run alone uses ~20,000 tokens), and
// the shared .env's 200,000 cap ran out in one afternoon. Only this verification instance gets
// the higher cap; the shell can still set its own.
env.HELPOS_AI_DAILY_TOKEN_BUDGET = process.env.HELPOS_AI_DAILY_TOKEN_BUDGET ?? "1000000";
process.stdout.write(
  `verify-helpos: API ${inst.apiUrl}  dashboard ${inst.webUrl}  db ${inst.dbName}  AI cap ${env.HELPOS_AI_DAILY_TOKEN_BUDGET} tokens/day\n`,
);
// The previous run's record: its pids may be reused by now, and this launch makes its own.
rmSync(launchRecord, { force: true });
const child = spawn("pnpm dev", { stdio: "inherit", shell: true, cwd: repoRoot, env });
let running = true;
// exitCode, not exit(): exiting while a fetch's socket closes crashes libuv on Windows.
child.on("exit", (code) => {
  running = false;
  process.exitCode = code ?? 1;
  // pnpm dev is gone, and its processes with it: a record would only name reused pids later.
  rmSync(launchRecord, { force: true });
});

/** Whether something answers HTTP on the port: a fetch, far cheaper than listing processes. */
const answers = (url) =>
  fetch(url, { signal: AbortSignal.timeout(1500) })
    .then(() => true)
    .catch(() => false);

function writeRecord(pids) {
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    launchRecord,
    `${JSON.stringify({ launchPid: process.pid, startedAt: new Date().toISOString(), pids }, null, 2)}\n`,
  );
}

// Record which processes this launch started (those below its own child), so cleanup.mjs stops
// only those. Polls for as long as pnpm dev runs: a slow first start is still recorded.
const startedAt = Date.now();
let warned = false;
let recordedPids = "";
while (running) {
  await new Promise((r) => setTimeout(r, 2000));
  // Processes are listed only once something answers, not on every poll of a slow start.
  const up = await Promise.all([`${inst.apiUrl}/health`, inst.webUrl].map(answers));
  const found = ports.map((port, i) =>
    up[i] ? listeners(port).filter((l) => l.helpos && descendsFrom(l.pid, child.pid)) : [],
  );
  // Recorded as soon as one port is up, so app:stop can stop it even if the other never comes.
  const sofar = found.flat().flatMap((l) => helposChain(l.pid, { stopAt: child.pid }));
  if (sofar.length > 0 && sofar.join(",") !== recordedPids) {
    writeRecord(sofar);
    recordedPids = sofar.join(",");
  }
  if (found.some((f) => f.length === 0)) {
    if (!warned && Date.now() - startedAt > 240_000) {
      warned = true;
      process.stdout.write(
        "verify-helpos: still waiting for the API and dashboard after 240s; " +
          "until both are up, pnpm app:stop has nothing recorded to stop.\n",
      );
    }
    continue;
  }
  process.stdout.write(`verify-helpos: recorded pids ${recordedPids} in ${launchRecord}\n`);
  break;
}
