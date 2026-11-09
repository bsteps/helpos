// Sends a customer email as a brand-new ticket: a sample from fixtures/email/ (plain.eml by
// default) with a fresh Message-ID and a unique subject, so it is never a duplicate.
//   node .claude/skills/verify-helpos/scripts/new-email.mjs [fixture] [--subject "text"] [--body "text"]
// fixture: a name in fixtures/email/ (attachment, xss, html…) or a path to any .eml file.
// With the default sample, --subject alone is also used as the body, so the email asks one thing.
// Prints the result, then the ticket id on the last line, and saves it as {ticket} for api.mjs.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instance, quit, remember, repoRoot, requireRunning, seed } from "./instance.mjs";

export async function sendFreshEmail(inst, fixture = "plain", { subject, body } = {}) {
  const named = join(repoRoot, "fixtures", "email", `${fixture.replace(/\.eml$/, "")}.eml`);
  const file = existsSync(named) ? named : resolve(fixture);
  if (!existsSync(file)) {
    throw new Error(
      `no email "${fixture}": use a name from fixtures/email/ or a path to a .eml file`,
    );
  }
  const stamp = new Date().toISOString().slice(11, 19);
  const original = readFileSync(file, "utf8").replaceAll(
    "support@acme.test",
    seed.northwind.mailbox,
  );
  const split = /\r?\n\r?\n/.exec(original);
  if (!split) throw new Error(`"${fixture}" has no blank line between its headers and body`);
  // One entry per header, continuation lines included, so a wrapped Subject is replaced whole.
  const lines = original.slice(0, split.index).split(/\r?\n(?![ \t])/);
  const oldSubject = lines.find((l) => /^Subject:/i.test(l)) ?? "Subject:";
  const sent =
    subject ?? `${oldSubject.slice("Subject:".length).replace(/\s+/g, " ").trim()} ${stamp}`.trim();
  // Always a fresh Message-ID, even when the sample has none, so it is never a duplicate.
  const headers = [
    ...lines.filter((l) => !/^(Message-ID|Subject):/i.test(l)),
    `Message-ID: <fresh-${crypto.randomUUID()}@customer.test>`,
    `Subject: ${sent}`,
  ].join("\r\n");
  let bodyPart = original.slice(split.index + split[0].length);
  const text = body ?? (subject && fixture === "plain" ? subject : undefined);
  if (text !== undefined) {
    if (!/^Content-Type:\s*text\/plain/im.test(headers) || /multipart/i.test(headers)) {
      throw new Error(`--body works only on a single-part text/plain sample, not "${fixture}"`);
    }
    bodyPart = `${text}\r\n`;
  }
  const raw = `${headers}\r\n\r\n${bodyPart}`;
  const res = await fetch(`${inst.apiUrl}/v1/inbound/email`, {
    method: "POST",
    headers: { authorization: `Bearer ${inst.inboundSecret}`, "content-type": "message/rfc822" },
    body: raw,
  });
  const answer = await res.text();
  let json;
  try {
    json = JSON.parse(answer);
  } catch {
    throw new Error(`inbound email answered ${res.status}, not JSON: ${answer.slice(0, 200)}`);
  }
  return { status: res.status, json, subject: sent };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flagValue = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const flagValues = new Set(
    ["--subject", "--body"].map((f) => args.indexOf(f) + 1).filter((i) => i > 0),
  );
  const fixture = args.find((a, i) => !a.startsWith("--") && !flagValues.has(i)) ?? "plain";
  const inst = instance();
  await requireRunning(inst);
  const {
    status,
    json,
    subject: sent,
  } = await sendFreshEmail(inst, fixture, {
    subject: flagValue("--subject"),
    body: flagValue("--body"),
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    quit(1);
  });
  process.stdout.write(`${status} ${json.status ?? json.error}: "${sent}"\n`);
  if (!json.ticketId) quit(1);
  process.stdout.write(`${json.ticketId}\n`);
  remember({ ticket: json.ticketId });
}
