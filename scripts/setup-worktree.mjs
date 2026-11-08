// `node scripts/setup-worktree.mjs`: prepares a fresh git worktree. T3 Code runs it when it creates
// a worktree (t3.json). Installs dependencies and links .env. The database and ports are set up
// by `pnpm dev`, isolated per worktree (scripts/worktree-env.mjs).
//
// Writes a marker in .helpos/ so an agent can wait instead of racing it:
//   setup-running  (contains the PID)  →  setup-done  or  setup-failed (with the error tail)
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envMessages, linkEnv } from "./worktree.mjs";

const dir = join(process.cwd(), ".helpos");
const markers = ["setup-running", "setup-done", "setup-failed"];
mkdirSync(dir, { recursive: true });
for (const m of markers) rmSync(join(dir, m), { force: true });
writeFileSync(join(dir, "setup-running"), `${process.pid}\n`);

function finish(marker, text) {
  writeFileSync(join(dir, marker), text);
  rmSync(join(dir, "setup-running"), { force: true });
}

try {
  process.stdout.write(`${envMessages[linkEnv()]}\n`);
  // Fixed command, run through the shell so Windows finds pnpm.cmd.
  const install = spawnSync("pnpm install --frozen-lockfile", {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(install.stdout ?? "");
  process.stderr.write(install.stderr ?? "");
  if (install.status !== 0) {
    const tail = `${install.stdout ?? ""}${install.stderr ?? ""}`.split("\n").slice(-40).join("\n");
    throw new Error(`pnpm install failed (exit ${install.status}):\n${tail}`);
  }
  finish("setup-done", `${new Date().toISOString()}\n`);
  process.stdout.write("Worktree ready. Run `pnpm dev`.\n");
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  finish("setup-failed", `${text}\n`);
  process.stderr.write(`\n✖ Worktree setup failed: ${text}\n`);
  process.exit(1);
}
