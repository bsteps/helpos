// Sends a customer email as a brand-new ticket: a sample from fixtures/email/ (plain.eml by
// default) with a fresh Message-ID and a unique subject, so it is never a duplicate.
//   node .claude/skills/verify-helpos/scripts/new-email.mjs [fixture] [--subject "text"] [--body "text"]
// fixture: a name in fixtures/email/ (attachment, xss, html…) or a path to any .eml file.
// With the default sample, --subject alone is also used as the body, so the email asks one thing.
// Prints the result, then the ticket id on the last line, and saves it as {ticket} for api.mjs.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instance, remember, repoRoot, requireRunning, seed } from "./instance.mjs";

export async function sendFreshEmail(inst, fixture = "plain", { subject, body } = {}) {
  const named = join(repoRoot, "fixtures", "email", `${fixture.replace(/\.eml$/, "")}.eml`);
  const file = existsSync(named) ? named : resolve(fixture);
  if (!existsSync(file)) {
    throw new Error(
      `no email "${fixture}": use a name from fixtures/email/ or a path to a .eml file`,
    );
  }
  const stamp = new Date().toISOString().slice(11, 19);
  let raw = readFileSync(file, "utf8")
    .replaceAll("support@acme.test", seed.northwind.mailbox)
    .replace(/^Message-ID:.*$/im, `Message-ID: <fresh-${crypto.randomUUID()}@customer.test>`)
    .replace(/^Subject:(.*)$/im, (_, old) => `Subject: ${subject ?? `${old.trim()} ${stamp}`}`);
  const text = body ?? (subject && fixture === "plain" ? subject : undefined);
  if (text !== undefined) {
    const split = raw.search(/\r?\n\r?\n/);
    const headers = raw.slice(0, split);
    if (!/^Content-Type:\s*text\/plain/im.test(headers) || /multipart/i.test(headers)) {
      throw new Error(`--body works only on a single-part text/plain sample, not "${fixture}"`);
    }
    raw = `${headers}\r\n\r\n${text}\r\n`;
  }
  const res = await fetch(`${inst.apiUrl}/v1/inbound/email`, {
    method: "POST",
    headers: { authorization: `Bearer ${inst.inboundSecret}`, "content-type": "message/rfc822" },
    body: raw,
  });
  return {
    status: res.status,
    json: await res.json(),
    subject: /^Subject: (.*)$/im.exec(raw)?.[1],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
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
    subject: valueOf("--subject"),
    body: valueOf("--body"),
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  process.stdout.write(`${status} ${json.status ?? json.error}: "${sent}"\n`);
  if (!json.ticketId) process.exit(1);
  process.stdout.write(`${json.ticketId}\n`);
  remember({ ticket: json.ticketId });
}
