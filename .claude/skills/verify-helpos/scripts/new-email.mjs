// Sends a customer email as a brand-new ticket: a sample from fixtures/email/ (plain.eml by
// default) with a fresh Message-ID and a unique subject, so it is never a duplicate.
//   node .claude/skills/verify-helpos/scripts/new-email.mjs [fixture] [--subject "text"] [--body "text"]
// fixture: a name in fixtures/email/ (attachment, xss, html…) or a path to any .eml file.
// With the default sample, --subject alone is also used as the body, so the email asks one thing.
// Prints the result, then the ticket id on the last line, and saves it as {ticket} for api.mjs.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiFetch,
  flagArg,
  inboundHeaders,
  instance,
  quit,
  remember,
  repoRoot,
  requireRunning,
  seed,
} from "./instance.mjs";

export async function sendFreshEmail(inst, fixture = "plain", { subject, body } = {}) {
  const named = join(repoRoot, "fixtures", "email", `${fixture.replace(/\.eml$/, "")}.eml`);
  const file = existsSync(named) ? named : resolve(fixture);
  if (!existsSync(file)) {
    throw new Error(
      `no email "${fixture}": use a name from fixtures/email/ or a path to a .eml file`,
    );
  }
  const { raw, sent } = freshEmail(readFileSync(file, "utf8"), {
    fixture,
    subject,
    body,
    mailbox: seed.northwind.mailbox,
    stamp: new Date().toISOString().slice(11, 19),
    messageId: `fresh-${crypto.randomUUID()}@customer.test`,
  });
  const res = await apiFetch(`${inst.apiUrl}/v1/inbound/email`, {
    method: "POST",
    headers: inboundHeaders(inst),
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

/**
 * The sample as a new email: addressed to `mailbox`, with a fresh Message-ID and a unique subject,
 * and `body` (or, for the plain sample, the subject) as its text. No I/O, so it is unit-tested.
 */
export function freshEmail(sample, { fixture, subject, body, mailbox, stamp, messageId }) {
  // A line break would end the Subject header and start another one.
  if (subject !== undefined && /[\r\n]/.test(subject))
    throw new Error("--subject must be one line");
  const original = sample.replaceAll("support@acme.test", mailbox);
  const split = /\r?\n\r?\n/.exec(original);
  if (!split) throw new Error(`"${fixture}" has no blank line between its headers and body`);
  // One entry per header, continuation lines included, so a wrapped Subject is replaced whole.
  const lines = original.slice(0, split.index).split(/\r?\n(?![ \t])/);
  const oldSubject = lines.find((l) => /^Subject:/i.test(l)) ?? "Subject:";
  const sent =
    subject ?? `${oldSubject.slice("Subject:".length).replace(/\s+/g, " ").trim()} ${stamp}`.trim();
  // Always a fresh Message-ID, even when the sample has none, so it is never a duplicate.
  // Each entry of `lines` is one whole header, continuation lines included, so dropping one
  // never leaves its folded tail behind to stick to the next header.
  let headerLines = [
    ...lines.filter((l) => !/^(Message-ID|Subject):/i.test(l)),
    `Message-ID: <${messageId}>`,
    `Subject: ${sent}`,
  ];
  let bodyPart = original.slice(split.index + split[0].length);
  // "plain" and "plain.eml" name the same default sample.
  const isPlain = fixture.replace(/\.eml$/, "") === "plain";
  const text = body ?? (subject && isPlain ? subject : undefined);
  if (text !== undefined) {
    const headers = headerLines.join("\r\n");
    if (!/^Content-Type:\s*text\/plain/im.test(headers) || /multipart/i.test(headers)) {
      throw new Error(`--body works only on a single-part text/plain sample, not "${fixture}"`);
    }
    bodyPart = `${text}\r\n`;
    // The new text is UTF-8 and unencoded: the sample's own charset or encoding (iso-8859-1,
    // base64, quoted-printable) would garble it.
    headerLines = [
      ...headerLines.filter((l) => !/^Content-(Transfer-Encoding|Type):/i.test(l)),
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
    ];
  }
  return { raw: `${headerLines.join("\r\n")}\r\n\r\n${bodyPart}`, sent };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flagValue = (flag) => flagArg(args, flag);
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
