// Read-only: is this checkout's HelpOS instance worth driving? Exit 0 when every required check
// passes. Warnings name features that will not work (no embeddings, no owner password).
//   node .claude/skills/verify-helpos/scripts/doctor.mjs [--wait <seconds>]
import { instance, launchedPids, seed, seedToken } from "./instance.mjs";
import { helposChain, listeners } from "./processes.mjs";

const inst = instance();
const waitArg = process.argv.indexOf("--wait");
const waitSeconds = waitArg > 0 ? Number(process.argv[waitArg + 1]) : 0;

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function ownedByHelpos(url) {
  const found = listeners(Number(new URL(url).port));
  if (found.length === 0) return { ok: false, detail: "nothing listening" };
  const stranger = found.find((l) => !l.helpos);
  if (stranger) {
    return { ok: false, detail: `pid ${stranger.pid} is not HelpOS: ${stranger.cmd.slice(0, 80)}` };
  }
  const ours = launchedPids();
  const launched = found.every((l) => helposChain(l.pid).some((pid) => ours.has(pid)));
  const pids = found.map((l) => l.pid).join(",");
  return {
    ok: true,
    detail: launched
      ? `pid ${pids}, started by launch.mjs`
      : `pid ${pids}, NOT started by launch.mjs: cleanup.mjs won't stop it`,
  };
}

const checks = [
  { name: "api port is HelpOS", run: async () => ownedByHelpos(inst.apiUrl) },
  {
    name: "api health",
    run: async () => {
      const { status, body } = await get(`${inst.apiUrl}/health`);
      return { ok: status === 200 && body.database === "ok", detail: JSON.stringify(body) };
    },
  },
  { name: "dashboard port is HelpOS", run: async () => ownedByHelpos(inst.webUrl) },
  {
    name: "dashboard proxies the API",
    run: async () => {
      const { status } = await get(`${inst.webUrl}/v1/me`);
      return { ok: status === 401, detail: `GET /v1/me unauthenticated → ${status} (want 401)` };
    },
  },
  {
    name: "mailpit",
    run: async () => {
      const { status } = await get(`${inst.mailpitUrl}/api/v1/info`);
      return { ok: status === 200, detail: `${status}` };
    },
  },
  {
    name: "inbound secret",
    run: async () => ({ ok: Boolean(inst.inboundSecret), detail: "HELPOS_INBOUND_SECRET in .env" }),
  },
  {
    name: "seed data",
    run: async () => {
      const token = await seedToken("northwind:triage-bot");
      const { status, body } = await get(`${inst.apiUrl}/v1/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return {
        ok: status === 200 && body.workspace?.name === "Northwind Cycles",
        detail:
          status === 200
            ? `triage-bot → ${body.workspace.name}`
            : `${status}: run pnpm db:seed via instance.mjs run`,
      };
    },
  },
  {
    name: "embeddings",
    warn: true,
    run: async () => {
      const token = await seedToken("northwind:triage-bot");
      const { body } = await get(`${inst.apiUrl}/v1/knowledge/sources`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const sources = body.sources ?? [];
      const pending = sources.filter((s) => s.status === "pending").length;
      return {
        ok: sources.length > 0 && pending === 0,
        detail: `${sources.length - pending}/${sources.length} sources ready`,
      };
    },
  },
  {
    name: "owner can sign in",
    warn: true,
    run: async () => {
      const { status } = await get(`${inst.apiUrl}/v1/auth/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: inst.webUrl },
        body: JSON.stringify({
          email: seed.northwind.owner,
          password: seed.northwind.ownerPassword,
        }),
      });
      return {
        ok: status === 200 || status === 204,
        detail: `${seed.northwind.owner} → ${status}; fix: owner-password.mjs`,
      };
    },
  },
];

async function runAll() {
  const results = [];
  for (const check of checks) {
    const result = await check
      .run()
      .catch((error) => ({ ok: false, detail: String(error.cause ?? error) }));
    results.push({ ...check, ...result });
  }
  return results;
}

const deadline = Date.now() + waitSeconds * 1000;
let results = await runAll();
while (results.some((r) => !r.ok && !r.warn) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  results = await runAll();
}

process.stdout.write(`instance ${inst.apiUrl} / ${inst.webUrl} / db ${inst.dbName}\n`);
for (const r of results) {
  const mark = r.ok ? "ok  " : r.warn ? "warn" : "FAIL";
  process.stdout.write(`${mark}  ${r.name.padEnd(26)} ${r.detail}\n`);
}
process.exit(results.some((r) => !r.ok && !r.warn) ? 1 : 0);
