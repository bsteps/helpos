// Plays GitHub: sends a signed `issues` webhook for the connected repo, the way GitHub would
// when an issue is closed or reopened. GitHub can't reach localhost, so this is how to test it.
//   node .claude/skills/verify-helpos/scripts/github-webhook.mjs <issueNumber> --secret <webhook secret>
//        [--action closed|reopened] [--reason completed|not_planned|duplicate] [--bad-signature]
// The secret is the one shown once by Settings → GitHub → Connect (or New webhook secret).
import { createHmac } from "node:crypto";
import {
  apiFetch,
  flagArg,
  getJson,
  instance,
  ownerCookie,
  quit,
  requireRunning,
} from "./instance.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => flagArg(args, name) ?? fallback;
const flagValues = new Set(
  ["--secret", "--action", "--reason"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0),
);
const number = Number(args.find((a, i) => !a.startsWith("--") && !flagValues.has(i)));
// From the environment too, so it needn't appear in the shell history or the process list.
const { GITHUB_WEBHOOK_SECRET: secretFromEnv } = process.env;
const secret = flagArg(args, "--secret", { anyValue: true }) ?? secretFromEnv;
if (!Number.isInteger(number) || number < 1 || !secret) {
  process.stderr.write(
    "Usage: github-webhook.mjs <issueNumber> (--secret <webhook secret> | GITHUB_WEBHOOK_SECRET=...) [--action closed|reopened] [--reason completed|not_planned|duplicate] [--bad-signature]\n",
  );
  quit(2);
}
const action = opt("--action", "closed");
const reason = opt("--reason", "completed");
// Checked before anything is sent: a typo must not reach the server as some other event.
if (!["closed", "reopened"].includes(action))
  quit(2, `--action is closed or reopened, not "${action}"`);
if (!["completed", "not_planned", "duplicate"].includes(reason)) {
  quit(2, `--reason is completed, not_planned or duplicate, not "${reason}"`);
}
const inst = instance();
await requireRunning(inst);

const cookie = await ownerCookie(inst);
// exitCode, not exit(): exiting while fetch's socket closes crashes libuv on Windows.
if (!cookie) {
  process.stderr.write("The owner can't sign in: run pnpm app:password first.\n");
  process.exitCode = 1;
} else {
  const me = await getJson(inst, "/v1/me", { cookie });
  const github = await getJson(inst, "/v1/integrations/github", { cookie });
  if (github.connected) await send(github.repo, me.workspace.id);
  else {
    process.stderr.write("No repo is connected: connect one in Settings → GitHub first.\n");
    process.exitCode = 1;
  }
}

async function send(repo, workspaceId) {
  const body = JSON.stringify({
    action,
    issue: {
      number,
      state: action === "closed" ? "closed" : "open",
      state_reason: action === "closed" ? reason : null,
      updated_at: new Date().toISOString(),
    },
    repository: { full_name: repo },
  });
  const key = args.includes("--bad-signature") ? `${secret}-wrong` : secret;
  const signature = `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

  const res = await apiFetch(
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
