// Runs every terminal step of the hand-test checklist against the running app, the way a person
// types it (through the real helper scripts), and checks each result. Run it after changing any
// helper or checklist step: a step that fails here would have failed for the person testing.
//   node .claude/skills/verify-helpos/scripts/selftest.mjs [--with-browser]
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { instance, lastCreated, requireRunning } from "./instance.mjs";

const scripts = join(import.meta.dirname);
const inst = instance();
await requireRunning(inst);

/** `out` is what the script printed; `all` adds its notes on stderr, such as `(saved {token} …)`. */
function run(script, args) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: "utf8",
    timeout: 180_000,
  });
  return { code: r.status ?? 1, out: r.stdout, all: `${r.stdout}${r.stderr}` };
}
const api = (...args) => run("api.mjs", args);
const status = (r) => Number(r.out.split("\n")[0]);
const json = (r) => JSON.parse(r.out.slice(r.out.indexOf("\n")));

/**
 * One row per checklist step: what is typed, and what must be seen. `expect` gets the result
 * and returns true, or a string saying what was wrong.
 */
const steps = [
  [
    "new-email prints 201 and the ticket",
    () => run("new-email.mjs", []),
    (r) => r.code === 0 && /^201 created/.test(r.out),
  ],
  [
    "new-email --subject is also the body",
    () => run("new-email.mjs", ["--subject", "How much does gift wrap cost?"]),
    (r) =>
      r.code === 0 &&
      json(api("northwind:triage-bot", "GET", "v1/tickets/{ticket}")).messages[0].text.trim() ===
        "How much does gift wrap cost?",
  ],
  [
    "new-email --subject --body",
    () => run("new-email.mjs", ["--subject", "Order question", "--body", "Do you ship to Norway?"]),
    (r) =>
      r.code === 0 &&
      json(api("northwind:triage-bot", "GET", "v1/tickets/{ticket}")).messages[0].text.trim() ===
        "Do you ship to Norway?",
  ],
  [
    "new-email xss --body is refused",
    () => run("new-email.mjs", ["xss", "--body", "x"]),
    (r) => r.code === 1 && /single-part/.test(r.all),
  ],
  [
    "new-email unknown sample is refused",
    () => run("new-email.mjs", ["nope"]),
    (r) => r.code === 1 && /no email "nope"/.test(r.all),
  ],
  [
    "new-email attachment",
    () => run("new-email.mjs", ["attachment"]),
    (r) => r.code === 0 && /Screenshot of the error/.test(r.out),
  ],
  [
    "new-email out-of-office is automated",
    () => run("new-email.mjs", ["out-of-office"]),
    (r) =>
      r.code === 0 &&
      json(api("northwind:triage-bot", "GET", "v1/tickets/{ticket}")).automated === true,
  ],
  ["new-email xss", () => run("new-email.mjs", ["xss"]), (r) => r.code === 0],
  [
    "duplicate plain.eml → 200",
    () => api("inbound", "POST", "v1/inbound/email", "@fixtures/email/plain.eml"),
    (r) => status(r) === 200 && json(r).status === "duplicate",
  ],
  [
    "inbound with no secret → 401",
    () => api("none", "POST", "v1/inbound/email", "@fixtures/email/plain.eml"),
    (r) => status(r) === 401,
  ],
  [
    "unknown mailbox → 404",
    () => api("inbound", "POST", "v1/inbound/email", "@fixtures/email/unknown-mailbox.eml"),
    (r) => status(r) === 404,
  ],

  [
    "me as owner: 9 scopes",
    () => api("owner", "GET", "v1/me"),
    (r) => status(r) === 200 && json(r).scopes.length === 9,
  ],
  [
    "me as triage-bot: agent, 3 scopes",
    () => api("northwind:triage-bot", "GET", "v1/me"),
    (r) => status(r) === 200 && json(r).actor.type === "agent" && json(r).scopes.length === 3,
  ],
  ["me as nobody → 401", () => api("none", "GET", "v1/me"), (r) => status(r) === 401],
  [
    "sign-in → 204",
    () =>
      api(
        "none",
        "POST",
        "v1/auth/sign-in",
        '{"email":"maya.okafor@northwind-cycles.test","password":"northwind demo password"}',
      ),
    (r) => status(r) === 204,
  ],

  ["fresh ticket for section 3", () => run("new-email.mjs", []), (r) => r.code === 0],
  [
    "list open tickets",
    () => api("northwind:triage-bot", "GET", "v1/tickets?status=open"),
    (r) => status(r) === 200 && json(r).tickets.length > 0,
  ],
  [
    "limit=2 returns 2",
    () => api("northwind:triage-bot", "GET", "v1/tickets?status=open&limit=2"),
    (r) => status(r) === 200 && json(r).tickets.length === 2,
  ],
  [
    "read {ticket}",
    () => api("northwind:triage-bot", "GET", "v1/tickets/{ticket}"),
    (r) => status(r) === 200 && json(r).id === lastCreated().ticket,
  ],
  [
    "other workspace → 404",
    () => api("lumen:support-agent", "GET", "v1/tickets/{ticket}"),
    (r) => status(r) === 404,
  ],
  [
    "approver can't close → 403",
    () => api("northwind:approver-bot", "POST", "v1/tickets/{ticket}/close"),
    (r) => status(r) === 403,
  ],
  [
    "owner closes",
    () => api("owner", "POST", "v1/tickets/{ticket}/close"),
    (r) => status(r) === 200 && json(r).status === "closed",
  ],

  ["fresh ticket for section 4", () => run("new-email.mjs", []), (r) => r.code === 0],
  [
    "edit {draft} (waits for the AI)",
    () =>
      api("northwind:triage-bot", "PATCH", "v1/drafts/{draft}", '{"body":"Changed by an agent"}'),
    (r) => status(r) === 200 && json(r).body === "Changed by an agent",
  ],
  [
    "triage-bot can't approve → 403",
    () => api("northwind:triage-bot", "POST", "v1/drafts/{draft}/approve", '{"body":{draftBody}}'),
    (r) => status(r) === 403,
  ],
  [
    "approve wrong text → 409",
    () =>
      api("northwind:approver-bot", "POST", "v1/drafts/{draft}/approve", '{"body":"not the text"}'),
    (r) => status(r) === 409 && json(r).error === "not_pending",
  ],
  [
    "approve exact text → 200",
    () =>
      api("northwind:approver-bot", "POST", "v1/drafts/{draft}/approve", '{"body":{draftBody}}'),
    (r) => status(r) === 200 && json(r).status === "approved",
  ],
  [
    "approve-draft new → sent",
    () => run("approve-draft.mjs", ["new"]),
    (r) => r.code === 0 && /approve → 200 approved/.test(r.out) && /sent at/.test(r.out),
  ],
  ["fresh ticket for discard", () => run("new-email.mjs", []), (r) => r.code === 0],
  [
    "approver can't discard → 403",
    () => api("northwind:approver-bot", "POST", "v1/drafts/{draft}/discard"),
    (r) => status(r) === 403,
  ],
  [
    "triage-bot discards",
    () => api("northwind:triage-bot", "POST", "v1/drafts/{draft}/discard"),
    (r) => status(r) === 200 && json(r).status === "discarded",
  ],
  [
    "retry a discarded draft → 409",
    () => api("northwind:approver-bot", "POST", "v1/drafts/{draft}/retry"),
    (r) => status(r) === 409 && json(r).error === "not_send_failed",
  ],
  [
    "regenerate → 202",
    () => api("northwind:triage-bot", "POST", "v1/tickets/{ticket}/drafts", '{"regenerate":true}'),
    (r) => status(r) === 202,
  ],
  [
    "own reply → 201",
    () =>
      api("northwind:triage-bot", "POST", "v1/tickets/{ticket}/drafts", '{"body":"My own reply"}'),
    (r) => status(r) === 201,
  ],

  [
    "knowledge list",
    () => api("northwind:triage-bot", "GET", "v1/knowledge/sources"),
    (r) => status(r) === 200 && json(r).sources.every((s) => s.status === "ready"),
  ],
  [
    "mint a knowledge token",
    () =>
      api(
        "owner",
        "POST",
        "v1/tokens",
        '{"name":"selftest-kb","scopes":["knowledge:read","knowledge:write"]}',
      ),
    (r) => status(r) === 201 && /saved \{token\}/.test(r.all),
  ],
  [
    "add a source with {token}",
    () =>
      api(
        "{token}",
        "POST",
        "v1/knowledge/sources",
        '{"kind":"markdown","title":"Selftest gift wrap","content":"# Gift wrap\\n\\nGift wrap costs 4 EUR per order.","visibility":"public"}',
      ),
    (r) => status(r) === 201,
  ],
  [
    "edit {source}",
    () => api("{token}", "PATCH", "v1/knowledge/sources/{source}", '{"visibility":"internal"}'),
    (r) => status(r) === 200,
  ],
  [
    "reingest {source}",
    () => api("{token}", "POST", "v1/knowledge/sources/{source}/reingest"),
    (r) => status(r) === 202,
  ],
  [
    "delete {source}",
    () => api("{token}", "DELETE", "v1/knowledge/sources/{source}"),
    (r) => status(r) === 204,
  ],
  [
    "triage-bot can't add → 403",
    () =>
      api(
        "northwind:triage-bot",
        "POST",
        "v1/knowledge/sources",
        '{"kind":"markdown","title":"x","content":"x"}',
      ),
    (r) => status(r) === 403,
  ],

  [
    "list tokens",
    () => api("owner", "GET", "v1/tokens"),
    (r) =>
      status(r) === 200 &&
      json(r).tokens.some((t) => t.name === "old-import-script" && t.revokedAt),
  ],
  [
    "revoke {tokenId}",
    () => api("owner", "DELETE", "v1/tokens/{tokenId}"),
    (r) => status(r) === 204,
  ],
  [
    "revoked {token} → 401",
    () => api("{token}", "GET", "v1/knowledge/sources"),
    (r) => status(r) === 401,
  ],
  [
    "token can't mint → 403",
    () =>
      api("northwind:triage-bot", "POST", "v1/tokens", '{"name":"x","scopes":["tickets:read"]}'),
    (r) => status(r) === 403 && json(r).error === "session_required",
  ],
  [
    "no admin tokens → 400",
    () => api("owner", "POST", "v1/tokens", '{"name":"x","scopes":["workspace:admin"]}'),
    (r) => status(r) === 400,
  ],
  [
    "stats-reader can't list tickets → 403",
    () => api("northwind:stats-reader", "GET", "v1/tickets"),
    (r) => status(r) === 403,
  ],

  [
    "shadow mode read",
    () => api("northwind:triage-bot", "GET", "v1/workspace/shadow-mode"),
    (r) => status(r) === 200 && json(r).enabled === true,
  ],
  [
    "shadow off is locked → 409",
    () => api("owner", "PATCH", "v1/workspace/shadow-mode", '{"enabled":false}'),
    (r) => status(r) === 409,
  ],
  [
    "shadow recipient → Leo",
    () =>
      api(
        "owner",
        "PATCH",
        "v1/workspace/shadow-mode",
        '{"recipient":"leo.brandt@northwind-cycles.test"}',
      ),
    (r) => status(r) === 200,
  ],
  [
    "shadow recipient → Maya",
    () =>
      api(
        "owner",
        "PATCH",
        "v1/workspace/shadow-mode",
        '{"recipient":"maya.okafor@northwind-cycles.test"}',
      ),
    (r) => status(r) === 200 && json(r).recipient.startsWith("maya"),
  ],
  [
    "triage-bot can't change shadow → 403",
    () =>
      api("northwind:triage-bot", "PATCH", "v1/workspace/shadow-mode", '{"recipient":"x@y.test"}'),
    (r) => status(r) === 403,
  ],
  [
    "stats",
    () => api("northwind:stats-reader", "GET", "v1/stats/drafts"),
    (r) => status(r) === 200,
  ],
  [
    "stats for January",
    () =>
      api(
        "northwind:stats-reader",
        "GET",
        "v1/stats/drafts?from=2026-01-06T00:00:00Z&to=2026-01-20T12:00:00Z",
      ),
    (r) => status(r) === 200 && json(r).approvedUnchanged >= 2,
  ],
  [
    "ai usage",
    () => api("northwind:triage-bot", "GET", "v1/ai-usage"),
    (r) => status(r) === 200 && typeof json(r).paused === "boolean",
  ],

  [
    "github not connected",
    () => api("owner", "GET", "v1/integrations/github"),
    (r) => status(r) === 200 && json(r).connected === false,
  ],
  [
    "classic github token → 400",
    () => api("owner", "PUT", "v1/integrations/github", '{"repo":"a/b","token":"ghp_classic"}'),
    (r) => status(r) === 400,
  ],
  [
    "triage-bot can't connect → 403",
    () =>
      api(
        "northwind:triage-bot",
        "PUT",
        "v1/integrations/github",
        '{"repo":"a/b","token":"github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      ),
    (r) => status(r) === 403,
  ],
  [
    "github-webhook with no repo says so",
    () => run("github-webhook.mjs", ["1", "--secret", "x"]),
    (r) => r.code === 1 && /No repo is connected/.test(r.all),
  ],
  [
    "app:run uses this worktree",
    () => run("instance.mjs", ["run", "node", "-e", "console.log(process.env.HELPOS_PORT)"]),
    (r) => r.code === 0 && r.out.trim() === new URL(inst.apiUrl).port,
  ],
];
if (process.argv.includes("--with-browser")) {
  steps.push([
    "browser journey",
    () => run("journey-reply.mjs", ["--via", "web"]),
    (r) => r.code === 0 && /PASS/.test(r.out),
  ]);
}

let failed = 0;
for (const [name, act, expect] of steps) {
  const result = act();
  let verdict;
  try {
    verdict = expect(result);
  } catch (error) {
    verdict = `could not read the answer: ${error.message}`;
  }
  if (verdict === true) {
    process.stdout.write(`ok    ${name}\n`);
  } else {
    failed++;
    const why =
      typeof verdict === "string" ? verdict : result.out.trim().split("\n").slice(0, 4).join(" | ");
    process.stdout.write(`FAIL  ${name}\n      ${why}\n`);
  }
}
process.stdout.write(`\n${steps.length - failed}/${steps.length} passed\n`);
process.exitCode = failed ? 1 : 0;
