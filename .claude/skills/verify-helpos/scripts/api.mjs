// Calls this checkout's API as a given caller and prints the status and JSON body.
//   node .claude/skills/verify-helpos/scripts/api.mjs <as> <METHOD> <path> [body]
// <path>: v1/tickets. Leave out the leading slash: Git Bash turns /v1/... into a Windows path.
// <as>:   a seed token name, e.g. northwind:triage-bot, northwind:approver-bot, lumen:support-agent
//         hos_…     a token you minted with POST v1/tokens
//         owner     the Northwind owner's session (signs in first; run owner-password.mjs once)
//         inbound   the email provider's shared secret; body is @<file>.eml, sent as message/rfc822,
//                   with support@acme.test (the fixtures' address) swapped for the Northwind mailbox
//         none      no credentials
// [body]: JSON text, or @file to read it from a file.
// Placeholders, filled from what the scripts last created (.helpos/verify/last.json):
//   {ticket}     the last ticket (from new-email.mjs or an inbound call)
//   {draft}      that ticket's pending draft, waiting for the AI if needed; {draftBody} is its
//                exact text as a JSON string, for approve: '{"body":{draftBody}}'
//   {token} {tokenId}  the last token minted with POST v1/tokens
//   {source}     the last knowledge source created
// Exit code 0 for a 2xx answer, 1 otherwise.
import { readFileSync } from "node:fs";
import {
  instance,
  lastCreated,
  quit,
  remember,
  requireRunning,
  seed,
  seedToken,
  whyNoDraft,
} from "./instance.mjs";

const hint = {
  ticket: "run new-email.mjs first",
  token: "mint one first: api.mjs owner POST v1/tokens '{...}'",
  tokenId: "mint one first: api.mjs owner POST v1/tokens '{...}'",
  source: "create one first: api.mjs {token} POST v1/knowledge/sources '{...}'",
};

const argv = process.argv.slice(2);
if (argv.length < 3) {
  process.stderr.write("Usage: api.mjs <as> <METHOD> v1/<path> [json | @file]\n");
  quit(2);
}
const inst = instance();
await requireRunning(inst);

const last = lastCreated();
// Only these names are placeholders; any other {word} is the person's own text.
const placeholder = /\{(ticket|draft|draftBody|token|tokenId|source)\}/g;
const placeholders = argv.join(" ").match(placeholder) ?? [];
const values = { ...last };
if (placeholders.some((p) => p === "{draft}" || p === "{draftBody}")) {
  const draft = await waitForDraft(last.ticket);
  values.draft = draft.id;
  values.draftBody = JSON.stringify(draft.body);
}
const fill = (text) =>
  text?.replace(placeholder, (whole, key) => {
    if (values[key] === undefined) {
      process.stderr.write(`${whole} is not known yet: ${hint[key] ?? "nothing creates it"}\n`);
      quit(2);
    }
    return values[key];
  });
const [as, method, rawPath, rawBody] = argv.map(fill);
const path = `/${rawPath.replace(/^\/+/, "")}`;
if (!path.startsWith("/v1/")) {
  process.stderr.write("Usage: api.mjs <as> <METHOD> v1/<path> [json | @file]\n");
  quit(2);
}
const headers = { origin: inst.webUrl };
let body = rawBody?.startsWith("@") ? readFileSync(rawBody.slice(1)) : rawBody;
if (body !== undefined && ["GET", "HEAD"].includes(method.toUpperCase())) {
  process.stderr.write(
    `A ${method.toUpperCase()} request can't have a body. Drop the last argument.\n`,
  );
  quit(2);
}
if (typeof body === "string" && as !== "inbound") {
  try {
    JSON.parse(body);
  } catch {
    process.stderr.write(
      `The body isn't valid JSON: ${body}\n` +
        'Through pnpm on Windows, a body with both " quotes and & | < > ^ gets cut at that ' +
        "character. Put the body in a file and pass @file instead.\n",
    );
    quit(2);
  }
}

if (as === "inbound") {
  // fixtures/email/*.eml are addressed to support@acme.test, which the seed data doesn't have.
  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8").replaceAll("support@acme.test", seed.northwind.mailbox);
  }
  headers.authorization = `Bearer ${inst.inboundSecret}`;
  headers["content-type"] = "message/rfc822";
} else {
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as === "owner") {
    const res = await fetch(`${inst.apiUrl}/v1/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: inst.webUrl },
      body: JSON.stringify({ email: seed.northwind.owner, password: seed.northwind.ownerPassword }),
    });
    if (res.status !== 204) {
      process.stderr.write(`owner sign-in failed (${res.status}): run owner-password.mjs\n`);
      quit(1);
    }
    headers.cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  } else if (as !== "none") {
    headers.authorization = `Bearer ${as.startsWith("hos_") ? as : await seedToken(as)}`;
  }
}
if (Buffer.isBuffer(body) && headers["content-type"] === "application/json")
  body = body.toString("utf8");

const res = await fetch(`${inst.apiUrl}${path}`, { method: method.toUpperCase(), headers, body });
const text = await res.text();
let shown = text;
try {
  shown = JSON.stringify(JSON.parse(text), null, 2);
} catch {}
process.stdout.write(`${res.status}\n${shown}\n`);
if (res.ok) {
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {}
  const post = method.toUpperCase() === "POST";
  // Only what a POST made or acted on: reading another ticket's draft must not move {ticket}.
  if (post && json.ticketId) remember({ ticket: json.ticketId });
  if (post && path === "/v1/tokens" && json.token)
    remember({ token: json.token, tokenId: json.id });
  if (post && path === "/v1/knowledge/sources" && json.id) remember({ source: json.id });
}
// exitCode, not exit(): exiting while fetch's socket closes crashes libuv on Windows.
process.exitCode = res.ok ? 0 : 1;

/** The ticket's newest live draft, waiting up to 2 minutes for the AI to write one. */
async function waitForDraft(ticket) {
  if (!ticket) {
    process.stderr.write(`{draft} needs a ticket first: ${hint.ticket}\n`);
    quit(2);
  }
  const reader = await seedToken("northwind:triage-bot");
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${inst.apiUrl}/v1/tickets/${ticket}/drafts`, {
      headers: { authorization: `Bearer ${reader}` },
    });
    const drafts = (await res.json()).drafts ?? [];
    const live = drafts.filter((d) => d.status !== "discarded");
    const pending = live.filter((d) => d.status === "pending");
    const draft =
      pending.find((d) => d.kind === "reply") ?? pending[0] ?? live.at(-1) ?? drafts.at(-1);
    if (draft) return draft;
    const why = await whyNoDraft(inst, ticket, reader);
    if (why) quit(1, `No draft on ticket ${ticket}: ${why}.`);
    if (i === 0) process.stderr.write("(waiting for the AI draft…)\n");
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stderr.write(`no draft on ticket ${ticket} after 2 minutes\n`);
  quit(1);
}
