// `pnpm dev`: start local services, apply migrations, then run the server and the dashboard in
// watch mode. The dashboard (http://localhost:5180) forwards API calls to the server (:3000).
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
process.stdout.write("Dashboard: http://localhost:5180\n");
const children = [
  spawn("pnpm --filter @helpos/server dev", { stdio: "inherit", shell: true }),
  spawn("pnpm --filter @helpos/web dev", { stdio: "inherit", shell: true }),
];
// One stopping stops the other. Killed by a signal means `code` is null: report failure.
for (const child of children) {
  child.on("exit", (code, signal) => {
    for (const other of children) if (other !== child) other.kill();
    process.exit(code ?? (signal ? 1 : 0));
  });
}
