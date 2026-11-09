// Plays GitHub: sends a signed `issues` webhook for the connected repo, the way GitHub would
// when an issue is closed or reopened. GitHub can't reach localhost, so this is how to test it.
//   node .claude/skills/verify-helpos/scripts/github-webhook.mjs <issueNumber> --secret <webhook secret>
//        [--action closed|reopened] [--reason completed|not_planned|duplicate] [--bad-signature]
// The secret is the one shown once by Settings → GitHub → Connect (or New webhook secret).
import { createHmac } from "node:crypto";
import { instance, requireRunning, seed } from "./instance.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const number = Number(args[0]);
const secret = opt("--secret");
if (!Number.isInteger(number) || number < 1 || !secret) {
  process.stderr.write(
    "Usage: github-webhook.mjs <issueNumber> --secret <webhook secret> [--action closed|reopened] [--reason completed|not_planned|duplicate] [--bad-signature]\n",
  );
  process.exit(2);
}
const inst = instance();
await requireRunning(inst);

const signIn = await fetch(`${inst.apiUrl}/v1/auth/sign-in`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: inst.webUrl },
  body: JSON.stringify({ email: seed.northwind.owner, password: seed.northwind.ownerPassword }),
});
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .join("; ");
const me = await (await fetch(`${inst.apiUrl}/v1/me`, { headers: { cookie } })).json();
const github = await (
  await fetch(`${inst.apiUrl}/v1/integrations/github`, { headers: { cookie } })
).json();
if (github.connected) await send(github.repo, me.workspace.id);
else {
  process.stderr.write("No repo is connected: connect one in Settings → GitHub first.\n");
  // exitCode, not exit(): exiting while fetch's socket closes crashes libuv on Windows.
  process.exitCode = 1;
}

async function send(repo, workspaceId) {
  const action = opt("--action", "closed");
  const body = JSON.stringify({
    action,
    issue: {
      number,
      state: action === "closed" ? "closed" : "open",
      state_reason: action === "closed" ? opt("--reason", "completed") : null,
      updated_at: new Date().toISOString(),
    },
    repository: { full_name: repo },
  });
  const key = args.includes("--bad-signature") ? `${secret}-wrong` : secret;
  const signature = `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

  const res = await fetch(
    `${inst.apiUrl}/v1/integrations/github/webhook?workspace=${workspaceId}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      body,
    },
  );
  process.stdout.write(
    `${repo}#${number} ${action}${action === "closed" ? ` (${opt("--reason", "completed")})` : ""} → ${res.status} ${await res.text()}\n`,
  );
  process.exitCode = res.ok ? 0 : 1;
}
