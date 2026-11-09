// Sends a customer email as a brand-new ticket: a sample from fixtures/email/ (plain.eml by
// default) with a fresh Message-ID and a unique subject, so it is never a duplicate.
//   node .claude/skills/verify-helpos/scripts/new-email.mjs [fixture] [--subject "text"]
// fixture: a name in fixtures/email/ (attachment, xss, html…) or a path to any .eml file.
// Prints the result, then the ticket id on the last line.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instance, repoRoot, requireRunning, seed } from "./instance.mjs";

export async function sendFreshEmail(inst, fixture = "plain", subject) {
  const named = join(repoRoot, "fixtures", "email", `${fixture.replace(/\.eml$/, "")}.eml`);
  const file = existsSync(named) ? named : resolve(fixture);
  if (!existsSync(file)) {
    throw new Error(
      `no email "${fixture}": use a name from fixtures/email/ or a path to a .eml file`,
    );
  }
  const stamp = new Date().toISOString().slice(11, 19);
  const raw = readFileSync(file, "utf8")
    .replaceAll("support@acme.test", seed.northwind.mailbox)
    .replace(/^Message-ID:.*$/im, `Message-ID: <fresh-${crypto.randomUUID()}@customer.test>`)
    .replace(/^Subject:(.*)$/im, (_, old) => `Subject: ${subject ?? `${old.trim()} ${stamp}`}`);
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
  const s = args.indexOf("--subject");
  const subject = s >= 0 ? args[s + 1] : undefined;
  const fixture = args.find((a, i) => !a.startsWith("--") && !(s >= 0 && i === s + 1)) ?? "plain";
  const inst = instance();
  await requireRunning(inst);
  const {
    status,
    json,
    subject: sent,
  } = await sendFreshEmail(inst, fixture, subject).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
  process.stdout.write(`${status} ${json.status ?? json.error}: "${sent}"\n`);
  if (!json.ticketId) process.exit(1);
  process.stdout.write(`${json.ticketId}\n`);
}
