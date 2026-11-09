// Starts `pnpm dev` for this checkout and stays in the foreground: run it as a background task.
// Adds local Ollama embeddings when Ollama answers and .env configures none, so knowledge
// sources get embedded instead of waiting in the queue.
//   node .claude/skills/verify-helpos/scripts/launch.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { evidenceRoot, instance, launchRecord, ollamaEmbedding, repoRoot } from "./instance.mjs";
import { helposChain, listeners } from "./processes.mjs";

const inst = instance();
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
const child = spawn("pnpm dev", { stdio: "inherit", shell: true, cwd: repoRoot, env });
child.on("exit", (code) => process.exit(code ?? 1));

// Record which processes this launch started, so cleanup.mjs stops only those.
const ports = [inst.apiUrl, inst.webUrl].map((u) => Number(new URL(u).port));
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const found = ports.map((port) => listeners(port).filter((l) => l.helpos));
  if (found.some((f) => f.length === 0)) continue;
  const pids = found.flat().flatMap((l) => helposChain(l.pid));
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    launchRecord,
    `${JSON.stringify({ launchPid: process.pid, startedAt: new Date().toISOString(), pids }, null, 2)}\n`,
  );
  process.stdout.write(`verify-helpos: recorded pids ${pids.join(",")} in ${launchRecord}\n`);
  break;
}
