// The main loop, end to end: a customer email arrives → ticket → AI draft → approval → the reply
// is sent and caught by Mailpit. The approval goes through the dashboard (--via web, signed in
// as the owner) or the agent API (--via api, the approver-bot token). Evidence goes to
// .helpos/verify/<timestamp>-reply-<via>/.
//   node .claude/skills/verify-helpos/scripts/journey-reply.mjs --via api|web [--headed]
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  apiFetch,
  evidenceRoot,
  flagArg,
  inboundHeaders,
  instance,
  isQuit,
  quit,
  repoRoot,
  requireRunning,
  seed,
  seedToken,
  whyNoDraft,
} from "./instance.mjs";

const via = flagArg(process.argv, "--via");
if (via !== "api" && via !== "web") {
  process.stderr.write("Usage: journey-reply.mjs --via api|web [--headed]\n");
  quit(2);
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
  quit(1);
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
  const res = await apiFetch(`${inst.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  return { status: res.status, body: res.status === 204 ? null : await jsonOf(res, path) };
}

/** Text without its line breaks and spacing, which the dashboard and the mailer may change. */
function flat(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** The response's JSON; anything else (a proxy's error page) fails the journey with its start. */
async function jsonOf(res, what) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`${what} answered ${res.status}, not JSON: ${text.slice(0, 200)}`);
  }
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
const inbound = await apiFetch(`${inst.apiUrl}/v1/inbound/email`, {
  method: "POST",
  headers: inboundHeaders(inst),
  body: raw,
});
const delivered = await jsonOf(inbound, "POST /v1/inbound/email");
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
  const found = body.drafts?.find((d) => d.status === "pending" && d.kind === "reply");
  if (found) return found;
  // Say at once when no draft can come (the AI budget is spent), instead of timing out.
  const why = await whyNoDraft(inst, delivered.ticketId, reader);
  if (why) fail(`no AI draft will come: ${why}`);
  return undefined;
});
record("worker wrote a pending AI draft", {
  draftId: draft.id,
  body: draft.body,
  sources: (draft.sources ?? []).map((s) => s.title ?? s.sourceId),
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
  // The dashboard's own Playwright (and its installed browsers), so the repo has one copy.
  const { chromium } = createRequire(join(repoRoot, "apps", "web", "package.json"))(
    "@playwright/test",
  );
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
    if (flat(shown ?? "") !== flat(draft.body)) fail("dashboard draft differs from the API draft");
    record("ticket page shows the AI draft, waiting for approval", { url: page.url() });

    await page.getByRole("button", { name: "Approve & send" }).click();
    await page.getByText("Sent", { exact: true }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: join(dir, "3-sent.png"), fullPage: true });
    record("clicked Approve & send; the page says Sent", {});
  } catch (error) {
    await page.screenshot({ path: join(dir, "failure.png"), fullPage: true }).catch(() => {});
    // A fail() inside the try already wrote its own reason to FAILED.txt: keep it.
    if (isQuit(error)) throw error;
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
  const res = await apiFetch(
    `${inst.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`subject:"Re: ${subject}"`)}`,
  );
  const { messages } = await jsonOf(res, "Mailpit search");
  return messages?.[0];
});
const detail = await jsonOf(
  await apiFetch(`${inst.mailpitUrl}/api/v1/message/${mail.ID}`),
  "Mailpit message",
);
writeFileSync(join(dir, "mail.json"), `${JSON.stringify(detail, null, 2)}\n`);
const to = detail.To.map((t) => t.Address.toLowerCase());
// Whoever the workspace names now, not the seed's default: a hand test may have changed it.
const { status: shadowStatus, body: shadow } = await api("/v1/workspace/shadow-mode");
if (shadowStatus !== 200)
  fail(`GET /v1/workspace/shadow-mode → ${shadowStatus} ${JSON.stringify(shadow)}`);
if (!shadow.enabled || !shadow.recipient) fail("shadow mode is off: this journey needs it on");
if (to.length !== 1 || to[0] !== shadow.recipient.toLowerCase())
  fail(`reply went to ${to.join(", ")}, not only the shadow recipient ${shadow.recipient}`);
if (!flat(detail.Text).includes(flat(draft.body))) fail("the sent text is not the approved draft");
record("Mailpit caught the reply, sent to the shadow recipient only", {
  to,
  subject: detail.Subject,
});

process.stdout.write(`PASS  evidence: ${dir}\n`);
