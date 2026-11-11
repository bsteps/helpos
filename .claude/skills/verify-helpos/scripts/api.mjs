// Calls this checkout's API as a given caller and prints the status and JSON body.
//   node .claude/skills/verify-helpos/scripts/api.mjs <as> <METHOD> <path> [body]
// <path>: v1/conversations. Leave out the leading slash: Git Bash turns /v1/... into a Windows path.
// <as>:   a seed token name, e.g. northwind:triage-bot, northwind:approver-bot, lumen:support-agent
//         hos_…     a token you minted with POST v1/tokens
//         owner     the Northwind owner's session (signs in first; run owner-password.mjs once)
//         inbound   the email provider's shared secret; body is @<file>.eml, sent as message/rfc822,
//                   with support@acme.test (the fixtures' address) swapped for the Northwind mailbox
//         none      no credentials
// [body]: JSON text, or @file to read it from a file.
// Placeholders, filled from what the scripts last created (.helpos/verify-state/last.json):
//   {conversation}     the last conversation (from new-email.mjs or an inbound call)
//   {draft}      that conversation's pending draft, waiting for the AI if needed; {draftBody} is its
//                exact text as a JSON string, for approve: '{"body":{draftBody}}'
//   {token} {tokenId}  the last token minted with POST v1/tokens
//   {source}     the last knowledge source created
// Exit code 0 for a 2xx answer, 1 otherwise.
import { readFileSync } from "node:fs";
import {
  apiFetch,
  getJson,
  inboundHeaders,
  instance,
  lastCreated,
  ownerCookie,
  quit,
  remember,
  requireRunning,
  seed,
  seedToken,
  whyNoDraft,
} from "./instance.mjs";

const hint = {
  conversation: "run new-email.mjs first",
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
const placeholder = /\{(conversation|draft|draftBody|token|tokenId|source)\}/g;
// A JSON body file may use them too (`@body.json` with {"body":{draftBody}}); an .eml is sent as is.
const bodyFile = argv[3]?.startsWith("@") ? argv[3].slice(1) : undefined;
// An email body: anything sent as inbound, or any .eml (`none` sends one to prove the inbound
// endpoint wants its secret). Sent as its bytes, with no placeholders, and only to that endpoint.
const emailBody = bodyFile && (argv[0] === "inbound" || bodyFile.endsWith(".eml"));
if (emailBody && argv[2]?.replace(/^\/+/, "") !== "v1/inbound/email") {
  quit(
    2,
    "An email body goes to the inbound endpoint: api.mjs inbound POST v1/inbound/email @file",
  );
}
const fileText = bodyFile && !emailBody ? readFileSync(bodyFile, "utf8") : undefined;
const placeholders = `${argv.join(" ")} ${fileText ?? ""}`.match(placeholder) ?? [];
// A saved value is an ID or a token; anything else in it (a hand-edited last.json) is refused,
// since it would be pasted into a path or JSON as it is.
for (const key of new Set(placeholders.map((p) => p.slice(1, -1)))) {
  const value = last[key];
  // Unknown yet is reported by fill(), with how to create it; {draft} comes from the conversation.
  if (value === undefined || key === "draft" || key === "draftBody") continue;
  if (typeof value !== "string" || !/^[\w-]+$/.test(value)) {
    quit(
      2,
      `The saved {${key}} looks damaged (${JSON.stringify(value)}): ${hint[key] ?? "create it again"}.`,
    );
  }
}
const values = { ...last };
// A body that can't be JSON fails now, not after two minutes of waiting for the AI's draft.
const jsonBody = fileText ?? (argv[3]?.startsWith("@") ? undefined : argv[3]);
if (jsonBody !== undefined && !emailBody && argv[0] !== "inbound") {
  const sample = jsonBody.replace(placeholder, (_, key) => (key === "draftBody" ? '"x"' : "x"));
  try {
    JSON.parse(sample);
  } catch {
    quit(
      2,
      `The body isn't valid JSON: ${jsonBody}\n` +
        'Through pnpm on Windows, a body with both " quotes and & | < > ^ gets cut at that ' +
        "character. Put the body in a file and pass @file instead.",
    );
  }
}
if (placeholders.some((p) => p === "{draft}" || p === "{draftBody}")) {
  const draft = await waitForDraft(last.conversation);
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
// Not inside an @file name: that is where the body comes from, not part of the request.
const [as, method, rawPath, rawBody] = argv.map((a, i) =>
  i === 3 && a.startsWith("@") ? a : fill(a),
);
const path = `/${rawPath.replace(/^\/+/, "")}`;
if (!path.startsWith("/v1/")) {
  process.stderr.write("Usage: api.mjs <as> <METHOD> v1/<path> [json | @file]\n");
  quit(2);
}
const headers = { origin: inst.webUrl };
let body =
  fileText !== undefined
    ? fill(fileText)
    : rawBody?.startsWith("@")
      ? readFileSync(rawBody.slice(1))
      : rawBody;
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
  headers.authorization = inboundHeaders(inst).authorization;
  headers["content-type"] = "message/rfc822";
} else {
  if (body !== undefined) headers["content-type"] = "application/json";
  if (as === "owner") {
    const cookie = await ownerCookie(inst);
    if (!cookie) quit(1, "The owner can't sign in: run pnpm app:password first.");
    headers.cookie = cookie;
  } else if (as !== "none") {
    headers.authorization = `Bearer ${as.startsWith("hos_") ? as : await seedToken(as)}`;
  }
}
if (Buffer.isBuffer(body) && headers["content-type"] === "application/json")
  body = body.toString("utf8");

const res = await apiFetch(`${inst.apiUrl}${path}`, {
  method: method.toUpperCase(),
  headers,
  body,
});
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
  // Only what a POST made or acted on: reading another conversation's draft must not move {conversation}.
  if (post && json.conversationId) remember({ conversation: json.conversationId });
  if (post && path === "/v1/tokens" && json.token)
    remember({ token: json.token, tokenId: json.id });
  if (post && path === "/v1/knowledge/sources" && json.id) remember({ source: json.id });
}
// exitCode, not exit(): exiting while fetch's socket closes crashes libuv on Windows.
process.exitCode = res.ok ? 0 : 1;

/** The conversation's newest live draft, waiting up to 2 minutes for the AI to write one. */
async function waitForDraft(conversation) {
  if (!conversation) {
    process.stderr.write(`{draft} needs a conversation first: ${hint.conversation}\n`);
    quit(2);
  }
  const reader = await seedToken("northwind:triage-bot");
  for (let i = 0; i < 60; i++) {
    const { drafts } = await getJson(inst, `/v1/conversations/${conversation}/drafts`, {
      authorization: `Bearer ${reader}`,
    });
    const live = drafts.filter((d) => d.status !== "discarded");
    const pending = live.filter((d) => d.status === "pending");
    // A live draft first; with only discarded ones left, the newest of those, so a step can
    // still act on it (retrying a discarded draft must answer 409, not wait for a new one).
    const draft =
      pending.find((d) => d.kind === "reply") ?? pending[0] ?? live.at(-1) ?? drafts.at(-1);
    if (draft) return draft;
    const why = await whyNoDraft(inst, conversation, reader);
    if (why) quit(1, `No draft on conversation ${conversation}: ${why}.`);
    if (i === 0) process.stderr.write("(waiting for the AI draft…)\n");
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stderr.write(`no draft on conversation ${conversation} after 2 minutes\n`);
  quit(1);
}
