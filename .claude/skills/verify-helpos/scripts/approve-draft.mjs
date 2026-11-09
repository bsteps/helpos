// An agent reviews and approves a ticket's pending draft over the API: it reads the draft as one
// token, then approves the exact text it read as another, and waits until the reply is sent.
//   node .claude/skills/verify-helpos/scripts/approve-draft.mjs <ticketId | new> [--reader <token>] [--approver <token>]
// `new` first sends a fresh customer email and uses its ticket. Defaults: reader northwind:triage-bot, approver northwind:approver-bot.
import { instance, requireRunning, seedToken } from "./instance.mjs";
import { sendFreshEmail } from "./new-email.mjs";

const args = process.argv.slice(2);
let ticketId = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i > 0 ? args[i + 1] : fallback;
};
if (!ticketId || ticketId.startsWith("--")) {
  process.stderr.write(
    "Usage: approve-draft.mjs <ticketId | new> [--reader <token>] [--approver <token>]\n",
  );
  process.exit(2);
}
const inst = instance();
await requireRunning(inst);
if (ticketId === "new") {
  const subject = `API approve ${new Date().toISOString().slice(11, 19)}`;
  const { status, json } = await sendFreshEmail(inst, "plain", subject);
  if (status !== 201) {
    process.stderr.write(`sending the customer email failed: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  ticketId = json.ticketId;
  process.stdout.write(`customer email sent: "${subject}", ticket ${ticketId}\n`);
}
const token = async (name) => (name.startsWith("hos_") ? name : seedToken(name));
const reader = await token(opt("--reader", "northwind:triage-bot"));
const approver = await token(opt("--approver", "northwind:approver-bot"));

async function call(method, path, bearer, body) {
  const res = await fetch(`${inst.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function drafts() {
  const { status, json } = await call("GET", `/v1/tickets/${ticketId}/drafts`, reader);
  if (status !== 200) {
    process.stderr.write(`reading drafts failed: ${status} ${JSON.stringify(json)}\n`);
    process.exit(1);
  }
  return json.drafts;
}

let pending;
for (let i = 0; i < 60 && !pending; i++) {
  pending = (await drafts()).find((d) => d.status === "pending");
  if (!pending) await new Promise((r) => setTimeout(r, 2000));
}
if (!pending) {
  process.stderr.write("no pending draft on this ticket after 2 minutes\n");
  process.exit(1);
}
process.stdout.write(`read draft ${pending.id}:\n---\n${pending.body}\n---\n`);

const approved = await call("POST", `/v1/drafts/${pending.id}/approve`, approver, {
  body: pending.body,
});
process.stdout.write(
  `approve → ${approved.status} ${approved.json.status ?? approved.json.error}\n`,
);
if (approved.status !== 200) process.exit(1);

for (let i = 0; i < 30; i++) {
  const now = (await drafts()).find((d) => d.id === pending.id);
  if (now?.status === "sent") {
    process.stdout.write(`sent at ${now.sentAt}. Check Mailpit for the reply.\n`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
process.stderr.write("approved, but not sent within 60s: is SMTP (Mailpit) up?\n");
process.exitCode = 1;
