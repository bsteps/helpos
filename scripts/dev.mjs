// `pnpm dev`: start local services, apply migrations, then run the server and the dashboard in
// watch mode. The dashboard (http://localhost:5180) forwards API calls to the server (:3000).
// Plain Node (no shell syntax) so it behaves the same on Windows, macOS and Linux.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

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
