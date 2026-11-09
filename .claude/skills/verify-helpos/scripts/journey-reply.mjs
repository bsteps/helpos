// The main loop, end to end: a customer email arrives → ticket → AI draft → approval → the reply
// is sent and caught by Mailpit. The approval goes through the dashboard (--via web, signed in
// as the owner) or the agent API (--via api, the approver-bot token). Evidence goes to
// .helpos/verify/<timestamp>-reply-<via>/.
//   node .claude/skills/verify-helpos/scripts/journey-reply.mjs --via api|web [--headed]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceRoot, instance, repoRoot, requireRunning, seed, seedToken } from "./instance.mjs";

const via = process.argv[process.argv.indexOf("--via") + 1];
if (via !== "api" && via !== "web") {
  process.stderr.write("Usage: journey-reply.mjs --via api|web [--headed]\n");
  process.exit(2);
}
const inst = instance();
await requireRunning(inst);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(evidenceRoot, `${stamp}-reply-${via}`);
mkdirSync(dir, { recursive: true });
const steps = [];
function record(step, observed) {
  steps.push({ at: new Date().toISOString(), step, observed });
  writeFileSync(join(dir, "steps.json"), `${JSON.stringify(steps, null, 2)}\n`);
  process.stdout.write(`✓ ${step}\n`);
}
function fail(message) {
  writeFileSync(join(dir, "FAILED.txt"), `${message}\n`);
  process.stderr.write(`✖ ${message}\nevidence: ${dir}\n`);
  process.exit(1);
}
async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out after ${seconds}s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const reader = await seedToken("northwind:triage-bot");
async function api(path, token = reader, init = {}) {
  const res = await fetch(`${inst.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

const subject = `Verify ${via} ${stamp}`;
const raw = [
  "From: Sam Rivera <sam.rivera@example.test>",
  `To: ${seed.northwind.mailbox}`,
  `Subject: ${subject}`,
  `Message-ID: <${crypto.randomUUID()}@example.test>`,
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi, how long does standard delivery take to Germany?",
  "",
].join("\r\n");
const inbound = await fetch(`${inst.apiUrl}/v1/inbound/email`, {
  method: "POST",
  headers: { authorization: `Bearer ${inst.inboundSecret}`, "content-type": "message/rfc822" },
  body: raw,
});
const delivered = await inbound.json();
if (inbound.status !== 201) fail(`inbound email → ${inbound.status} ${JSON.stringify(delivered)}`);
record("customer email delivered to POST /v1/inbound/email", { status: 201, ...delivered });

const ticket = await api(`/v1/tickets/${delivered.ticketId}`);
if (ticket.status !== 200 || ticket.body.subject !== subject)
  fail(`ticket not readable: ${ticket.status}`);
record("ticket exists with the email's subject", {
  subject: ticket.body.subject,
  status: ticket.body.status,
});

const draft = await until("the AI draft", 120, async () => {
  const { body } = await api(`/v1/tickets/${delivered.ticketId}/drafts`);
  return body.drafts?.find((d) => d.status === "pending" && d.kind === "reply");
});
record("worker wrote a pending AI draft", {
  draftId: draft.id,
  body: draft.body,
  sources: draft.sources.map((s) => s.title ?? s.sourceId),
});

if (via === "api") {
  const approver = await seedToken("northwind:approver-bot");
  const approved = await api(`/v1/drafts/${draft.id}/approve`, approver, {
    method: "POST",
    body: JSON.stringify({ body: draft.body }),
  });
  if (approved.status !== 200)
    fail(`approve → ${approved.status} ${JSON.stringify(approved.body)}`);
  record("approver-bot approved via POST /v1/drafts/{id}/approve", {
    status: approved.body.status,
  });
} else {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: !process.argv.includes("--headed") });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  try {
    await page.goto(`${inst.webUrl}/login`);
    await page.getByLabel("Email").fill(seed.northwind.owner);
    await page.getByLabel("Password").fill(seed.northwind.ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Inbox" }).waitFor();
    await page.screenshot({ path: join(dir, "1-inbox.png") });
    record("owner signed in to the dashboard", { url: page.url() });

    await page.getByRole("link", { name: subject }).click();
    await page.getByRole("heading", { name: subject }).waitFor();
    await page.getByText("Waiting for approval").waitFor();
    const shown = await page.getByTestId("draft-body").textContent();
    await page.screenshot({ path: join(dir, "2-ticket-draft.png"), fullPage: true });
    if (shown.trim() !== draft.body.trim()) fail("dashboard draft differs from the API draft");
    record("ticket page shows the AI draft, waiting for approval", { url: page.url() });

    await page.getByRole("button", { name: "Approve & send" }).click();
    await page.getByText("Sent", { exact: true }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: join(dir, "3-sent.png"), fullPage: true });
    record("clicked Approve & send; the page says Sent", {});
  } catch (error) {
    await page.screenshot({ path: join(dir, "failure.png"), fullPage: true }).catch(() => {});
    fail(`dashboard step failed: ${error.message.split("\n")[0]}`);
  } finally {
    await browser.close();
  }
}

const sent = await until("the draft to be sent", 60, async () => {
  const { body } = await api(`/v1/tickets/${delivered.ticketId}/drafts`);
  return body.drafts?.find((d) => d.id === draft.id && d.status === "sent");
});
record("draft is sent", { status: sent.status, sentAt: sent.sentAt });

const mail = await until("Mailpit to catch the reply", 30, async () => {
  const res = await fetch(
    `${inst.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`subject:"Re: ${subject}"`)}`,
  );
  const { messages } = await res.json();
  return messages?.[0];
});
const detail = await (await fetch(`${inst.mailpitUrl}/api/v1/message/${mail.ID}`)).json();
writeFileSync(join(dir, "mail.json"), `${JSON.stringify(detail, null, 2)}\n`);
const to = detail.To.map((t) => t.Address);
if (!to.includes(seed.northwind.owner))
  fail(`reply went to ${to.join(", ")}, not the shadow recipient`);
if (to.includes("sam.rivera@example.test"))
  fail("shadow mode is on, yet the customer got the reply");
if (!detail.Text.includes(draft.body.split("\n")[0].trim()))
  fail("the sent text is not the approved draft");
record("Mailpit caught the reply, sent to the shadow recipient only", {
  to,
  subject: detail.Subject,
});

process.stdout.write(`PASS  evidence: ${dir}\n`);
