// Is this checkout's HelpOS instance worth driving? Exit 0 when every required check passes.
// Warnings name features that will not work (no embeddings, no owner password). It changes
// nothing, except one owner sign-in when the saved owner session no longer works: that session
// is saved for the other helpers, as theirs would be.
//   node .claude/skills/verify-helpos/scripts/doctor.mjs [--wait <seconds>]
import {
  apiFetch,
  brand,
  flagArg,
  instance,
  launchedPids,
  ownerCookie,
  quit,
  seed,
  seedToken,
} from "./instance.mjs";
import { helposChain, listeners } from "./processes.mjs";

const inst = instance();
const waitSeconds = Number(flagArg(process.argv, "--wait") ?? 0);
if (!Number.isFinite(waitSeconds) || waitSeconds < 0) quit(2, "--wait takes a number of seconds");

async function get(url, init = {}) {
  const res = await apiFetch(url, { ...init, signal: AbortSignal.timeout(5000) });
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
    return {
      ok: false,
      detail: `pid ${stranger.pid} is not ${brand.name}: ${stranger.cmd.slice(0, 80)}`,
    };
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
  { name: `api port is ${brand.name}`, run: async () => ownedByHelpos(inst.apiUrl) },
  {
    name: "api health",
    run: async () => {
      const { status, body } = await get(`${inst.apiUrl}/health`);
      return { ok: status === 200 && body.database === "ok", detail: JSON.stringify(body) };
    },
  },
  { name: `dashboard port is ${brand.name}`, run: async () => ownedByHelpos(inst.webUrl) },
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
            : `${status}: run pnpm app:run pnpm db:seed`,
      };
    },
  },
  {
    name: "AI model",
    run: async () => ({
      ok: inst.aiConfigured,
      detail: inst.aiConfigured
        ? "AI_PROVIDER, AI_MODEL, AI_API_KEY set"
        : "AI_* missing in .env: no drafts will ever be written",
    }),
  },
  {
    name: "AI budget left today",
    warn: true,
    run: async () => {
      const token = await seedToken("northwind:triage-bot");
      const { status, body } = await get(`${inst.apiUrl}/v1/ai-usage`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (status !== 200 || typeof body.remainingTokens !== "number") {
        return { ok: false, detail: `GET /v1/ai-usage → ${status} ${JSON.stringify(body)}` };
      }
      return {
        ok: !body.paused && body.remainingTokens >= 30_000,
        detail: body.paused
          ? `spent (${body.totalTokens}/${body.dailyTokenBudget}): no AI drafts until midnight UTC`
          : `${body.remainingTokens} of ${body.dailyTokenBudget} tokens (about 1,300 per draft)`,
      };
    },
  },
  {
    name: "shadow mode locked",
    run: async () => ({
      ok: !inst.shadowOffAllowed,
      detail: inst.shadowOffAllowed
        ? "HELPOS_ALLOW_SHADOW_MODE_OFF=true: replies could reach customers; set it to false"
        : "replies can only go to the shadow recipient",
    }),
  },
  {
    name: "encryption key",
    warn: true,
    run: async () => ({
      ok: inst.encryptionKeySet,
      detail: inst.encryptionKeySet
        ? "HELPOS_ENCRYPTION_KEY set"
        : "no HELPOS_ENCRYPTION_KEY: GitHub can't be connected",
    }),
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
      if (sources.length === 0) return { ok: true, detail: "no knowledge sources yet" };
      const count = (status) =>
        sources.filter(
          (s) =>
            s.state.status === status || (status === "pending" && s.state.status === "waiting"),
        ).length;
      const ready = count("ready");
      const failed = count("failed");
      return {
        ok: ready === sources.length,
        detail:
          `${ready}/${sources.length} sources ready` +
          (count("pending") ? `, ${count("pending")} waiting for embeddings` : "") +
          (failed ? `, ${failed} failed` : ""),
      };
    },
  },
  {
    name: "owner can sign in",
    warn: true,
    // Once at the end, not on every --wait poll, and through the saved session the other helpers
    // use: it signs in only when that session no longer works, so runs don't pile up sessions.
    once: true,
    run: async () => {
      const cookie = await ownerCookie(inst);
      return {
        ok: cookie !== null,
        detail: cookie
          ? `${seed.northwind.owner} has a working session`
          : `${seed.northwind.owner} can't sign in; fix: pnpm app:password`,
      };
    },
  },
];

async function runAll(which) {
  const results = [];
  for (const check of checks.filter(which)) {
    const result = await check
      .run()
      .catch((error) => ({ ok: false, detail: String(error.cause ?? error) }));
    results.push({ ...check, ...result });
  }
  return results;
}

const deadline = Date.now() + waitSeconds * 1000;
const polled = (c) => !c.once;
let results = await runAll(polled);
while (results.some((r) => !r.ok && !r.warn) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  results = await runAll(polled);
}
results.push(...(await runAll((c) => c.once)));

process.stdout.write(`instance ${inst.apiUrl} / ${inst.webUrl} / db ${inst.dbName}\n`);
for (const r of results) {
  const mark = r.ok ? "ok  " : r.warn ? "warn" : "FAIL";
  process.stdout.write(`${mark}  ${r.name.padEnd(26)} ${r.detail}\n`);
}
process.exitCode = results.some((r) => !r.ok && !r.warn) ? 1 : 0;
