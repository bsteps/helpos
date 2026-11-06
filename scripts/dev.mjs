// `pnpm dev`: start local services, apply migrations, then run the server in watch mode.
// Plain Node (no shell syntax) so it behaves the same on Windows, macOS and Linux.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

// Commands are fixed strings (no user input). They run through the shell so Windows finds
// `pnpm.cmd`; passing one string avoids Node's unescaped-args warning (DEP0190).
function run(command) {
  const result = spawnSync(command, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.stderr.write(`\n✖ "${command}" failed.\n`);
    if (command.startsWith("docker")) process.stderr.write("  Is Docker running?\n");
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  process.stdout.write("Created .env from .env.example\n");
}

run("docker compose up -d --wait");
run("pnpm --filter @helpos/db migrate");

process.stdout.write("Mailpit (caught emails): http://localhost:8025\n");
const server = spawn("pnpm --filter @helpos/server dev", { stdio: "inherit", shell: true });
// Killed by a signal means `code` is null: report failure, not success.
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
