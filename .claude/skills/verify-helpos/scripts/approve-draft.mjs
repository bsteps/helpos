// An agent reviews and approves a conversation's pending draft over the API: it reads the draft as one
// token, then approves the exact text it read as another, and waits until the reply is sent.
//   node .claude/skills/verify-helpos/scripts/approve-draft.mjs <conversationId | new> [--reader <token>] [--approver <token>]
// `new` first sends a fresh customer email and uses its conversation. Defaults: reader northwind:triage-bot, approver northwind:approver-bot.
import {
  apiFetch,
  flagArg,
  instance,
  quit,
  remember,
  requireRunning,
  seedToken,
  whyNoDraft,
} from "./instance.mjs";
import { sendFreshEmail } from "./new-email.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => flagArg(args, name) ?? fallback;
const flagValues = new Set(
  ["--reader", "--approver", "--subject", "--body"]
    .map((f) => args.indexOf(f) + 1)
    .filter((i) => i > 0),
);
let conversationId = args.find((a, i) => !a.startsWith("--") && !flagValues.has(i));
if (!conversationId) {
  process.stderr.write(
    "Usage: approve-draft.mjs <conversationId | new> [--reader <token>] [--approver <token>] [--subject <text>] [--body <text>]\n",
  );
  quit(2);
}
const inst = instance();
await requireRunning(inst);
if (conversationId === "new") {
  const subject = opt("--subject", `API approve ${new Date().toISOString().slice(11, 19)}`);
  const { status, json } = await sendFreshEmail(inst, "plain", {
    subject,
    body: opt("--body", "Hi, I cannot log in since this morning."),
  }).catch((error) => quit(1, error.message));
  if (status !== 201) {
    process.stderr.write(`sending the customer email failed: ${status} ${JSON.stringify(json)}\n`);
    quit(1);
  }
  conversationId = json.conversationId;
  process.stdout.write(`customer email sent: "${subject}", conversation ${conversationId}\n`);
  remember({ conversation: conversationId });
}
const token = async (name) => (name.startsWith("hos_") ? name : seedToken(name));
const reader = await token(opt("--reader", "northwind:triage-bot"));
const approver = await token(opt("--approver", "northwind:approver-bot"));

async function call(method, path, bearer, body) {
  const res = await apiFetch(`${inst.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  } catch {
    quit(1, `${method} ${path} answered ${res.status}, not JSON: ${text.slice(0, 200)}`);
  }
}
async function drafts() {
  const { status, json } = await call("GET", `/v1/conversations/${conversationId}/drafts`, reader);
  if (status !== 200) {
    process.stderr.write(`reading drafts failed: ${status} ${JSON.stringify(json)}\n`);
    quit(1);
  }
  return json.drafts;
}

let pending;
for (let i = 0; i < 60 && !pending; i++) {
  const all = await drafts();
  pending = all.find((d) => d.status === "pending");
  if (pending) break;
  // Already past pending: say so now rather than wait two minutes for nothing.
  const done = all.find((d) => ["approved", "sent"].includes(d.status));
  if (done) quit(1, `Nothing to approve: draft ${done.id} is already ${done.status}.`);
  const why = await whyNoDraft(inst, conversationId, reader);
  if (why) quit(1, `No draft to approve: ${why}.`);
  await new Promise((r) => setTimeout(r, 2000));
}
if (!pending) {
  process.stderr.write("no pending draft on this conversation after 2 minutes\n");
  quit(1);
}
process.stdout.write(`read draft ${pending.id}:\n---\n${pending.body}\n---\n`);

const approved = await call("POST", `/v1/drafts/${pending.id}/approve`, approver, {
  body: pending.body,
});
process.stdout.write(
  `approve → ${approved.status} ${approved.json.status ?? approved.json.error}\n`,
);
if (approved.status !== 200) quit(1);

for (let i = 0; i < 30; i++) {
  const now = (await drafts()).find((d) => d.id === pending.id);
  if (now?.status === "sent") {
    process.stdout.write(`sent at ${now.sentAt}. Check Mailpit for the reply.\n`);
    quit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
process.stderr.write("approved, but not sent within 60s: is SMTP (Mailpit) up?\n");
process.exitCode = 1;
