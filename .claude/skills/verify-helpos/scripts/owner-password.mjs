// Gives the Northwind Cycles owner the known demo password, through the real one-time link flow:
// `pnpm helpos:init` prints the link, then the link's token is posted to /v1/auth/password.
// Safe to rerun: once a password is set, it only checks that sign-in works.
//   node .claude/skills/verify-helpos/scripts/owner-password.mjs

import { apiFetch, instance, quit, requireRunning, runCommand, seed } from "./instance.mjs";

const inst = instance();
await requireRunning(inst);
const { mailbox, owner, ownerPassword } = seed.northwind;

async function post(path, body) {
  return apiFetch(`${inst.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: inst.webUrl },
    body: JSON.stringify(body),
  });
}

// An argument list, not a shell string: no value can split or run anything.
const init = runCommand(
  [
    "pnpm",
    "--silent",
    "helpos:init",
    "--workspace",
    "Northwind Cycles",
    "--mailbox",
    mailbox,
    "--owner",
    owner,
  ],
  inst,
  { encoding: "utf8" },
);
// A failed init (the workspace may already exist) falls through to the sign-in check below,
// which says whether the owner already has the demo password; its output is shown if not.
const initFailed = init.status !== 0 ? `helpos:init failed:\n${init.stderr}${init.stdout}` : "";
const link = /https?:\/\/\S+#token=\S+/.exec(init.stdout)?.[0];
if (link) {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
  const res = await post("/v1/auth/password", { token, password: ownerPassword });
  if (res.status !== 204) {
    process.stderr.write(`setting the password failed: ${res.status} ${await res.text()}\n`);
    quit(1);
  }
}

const signIn = await post("/v1/auth/sign-in", { email: owner, password: ownerPassword });
if (signIn.status !== 204) {
  if (initFailed) quit(1, initFailed);
  process.stderr.write(
    `${owner} has a password, but not the demo one (${signIn.status}). ` +
      "Someone set it by hand; reset the worktree database or sign in with theirs.\n",
  );
  quit(1);
}
process.stdout.write(
  `${link ? "password set" : "password already set"}: ${owner} / ${ownerPassword}\n`,
);
