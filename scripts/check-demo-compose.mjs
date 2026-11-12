// `node scripts/check-demo-compose.mjs`: proves deploy/demo/compose.yaml is valid and keeps the
// demo safe. Run by CI. Needs Docker Compose. It renders the file with an operator .env that
// tries to turn shadow mode off, then checks what the server would really get.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSchema } from "../apps/server/src/env.ts";

const dir = mkdtempSync(join(tmpdir(), "demo-compose-"));
const envFile = join(dir, ".env");
const example = readFileSync("deploy/demo/.env.example", "utf8");
// A hostile or mistaken operator .env that tries to turn shadow mode off.
writeFileSync(
  envFile,
  `${example}\nAI_API_KEY=synthetic-compose-check-key\nHELPOS_ALLOW_SHADOW_MODE_OFF=true\n`,
);

const result = spawnSync(
  "docker",
  [
    "compose",
    "-f",
    "deploy/demo/compose.yaml",
    "--env-file",
    envFile,
    "config",
    "--format",
    "json",
  ],
  { encoding: "utf8" },
);
rmSync(dir, { recursive: true, force: true });
if (result.status !== 0) fail(`docker compose config failed:\n${result.stderr}`);

const { services } = JSON.parse(result.stdout);
const failures = [];
const check = (ok, message) => ok || failures.push(message);

const server = services.server;
check(
  server?.environment?.HELPOS_ALLOW_SHADOW_MODE_OFF === "false",
  "the server must get HELPOS_ALLOW_SHADOW_MODE_OFF=false, whatever .env says",
);
// What the server itself will make of its environment: shadow mode must stay locked on.
const parsed = envSchema.safeParse(server?.environment ?? {});
check(parsed.success, `the server's environment is invalid: ${parsed.error?.message}`);
check(
  parsed.data?.HELPOS_ALLOW_SHADOW_MODE_OFF === false,
  "the server would allow shadow mode off",
);
check(parsed.data?.HELPOS_PUBLIC_URL.startsWith("https://"), "the public URL must be HTTPS");
check(
  services.postgres?.image?.startsWith("pgvector/pgvector:pg17"),
  "Postgres must be pg17 + pgvector",
);
check(Boolean(services.backup), "the daily backup service is missing");
// The server's roles can't bypass row-level security. It must never hold the ones that can.
const serverEnv = JSON.stringify(server?.environment ?? {});
check(!serverEnv.includes("helpos_owner"), "the server must not get the owner role");
check(!/POSTGRES_|PGPASSWORD/.test(serverEnv), "the server must not get the superuser password");
for (const [name, service] of Object.entries(services)) {
  check(
    /@sha256:[0-9a-f]{64}$/.test(service.image ?? "") || service.image === "helpos-demo:latest",
    `${name}: pin the image by digest`,
  );
  check(service.logging?.options?.["max-size"], `${name}: cap the log size`);
  check(service.mem_limit, `${name}: set a memory limit`);
  check(name === "caddy" || !service.ports?.length, `only caddy may publish ports, not ${name}`);
}

if (failures.length) fail(failures.map((f) => `✖ ${f}`).join("\n"));
process.stdout.write("deploy/demo/compose.yaml: valid, shadow mode locked on\n");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
