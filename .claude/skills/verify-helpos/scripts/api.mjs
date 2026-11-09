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
// Exit code 0 for a 2xx answer, 1 otherwise.
import { readFileSync } from "node:fs";
import { instance, seed, seedToken } from "./instance.mjs";

const [as, method, rawPath, rawBody] = process.argv.slice(2);
const path = rawPath && `/${rawPath.replace(/^\/+/, "")}`;
if (!as || !method || !path?.startsWith("/v1/")) {
  process.stderr.write("Usage: api.mjs <as> <METHOD> v1/<path> [json | @file]\n");
  process.exit(2);
}
const inst = instance();
const headers = { origin: inst.webUrl };
let body = rawBody?.startsWith("@") ? readFileSync(rawBody.slice(1)) : rawBody;

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
      process.exit(1);
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
// exitCode, not exit(): exiting while fetch's socket closes crashes libuv on Windows.
process.exitCode = res.ok ? 0 : 1;
