// Runs every terminal step of the hand-test checklist against the running app, the way a person
// types it (through the real helper scripts), and checks each result. Run it after changing any
// helper or checklist step: a step that fails here would have failed for the person testing.
//   node .claude/skills/verify-helpos/scripts/selftest.mjs [--with-browser]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allScopes,
  getJson,
  instance,
  lastCreated,
  lastFile,
  quit,
  repoRoot,
  requireRunning,
  seedToken,
  seedTokenScopes,
} from "./instance.mjs";

const scripts = join(import.meta.dirname);
const inst = instance();
await requireRunning(inst);

// A run writes about 15 AI drafts, roughly 20,000 tokens. Without that much left, the draft
// steps can't pass, and running anyway would also leave the person testing with none.
const neededTokens = 30_000;
const usage = await getJson(inst, "/v1/ai-usage", {
  authorization: `Bearer ${await seedToken("northwind:triage-bot")}`,
});
if (typeof usage.remainingTokens !== "number") {
  quit(1, `GET /v1/ai-usage has no remainingTokens: ${JSON.stringify(usage)}`);
}
if (usage.paused || usage.remainingTokens < neededTokens) {
  quit(
    1,
    `Not enough AI budget left today: ${usage.remainingTokens} of ${usage.dailyTokenBudget} tokens ` +
      `(a run needs about ${neededTokens}). It resets at midnight UTC.`,
  );
}

// The person's {conversation}, {token}… survive a selftest run in the middle of their checklist.
const saved = existsSync(lastFile) ? readFileSync(lastFile, "utf8") : undefined;
// Its time too: lastCreated() compares it with the seed marker to spot IDs from before a reset.
const savedAt = saved === undefined ? undefined : statSync(lastFile).mtime;
// From the server's own lists, so adding a scope doesn't break a step that isn't about it.
const ownerScopes = await allScopes();
const triageScopes = await seedTokenScopes("northwind:triage-bot");
/** The shadow recipient before the selftest changed it, and whether it was put back. */
let shadowRecipient;
let shadowRestored = false;
let restored = false;
function restoreSaved() {
  // Once: Ctrl+C restores, then the exit that follows must not do it again.
  if (restored) return;
  restored = true;
  if (saved === undefined) rmSync(lastFile, { force: true });
  else {
    writeFileSync(lastFile, saved);
    utimesSync(lastFile, savedAt, savedAt);
  }
  // The shadow recipient too, if a step changed it and the run stopped before putting it back.
  if (shadowRecipient && !shadowRestored) {
    run("api.mjs", [
      "owner",
      "PATCH",
      "v1/workspace/shadow-mode",
      JSON.stringify({ recipient: shadowRecipient }),
    ]);
  }
}
process.on("exit", restoreSaved);
// Ctrl+C skips "exit": restore first, then stop. A hard kill can't be caught.
process.on("SIGINT", () => {
  restoreSaved();
  process.kill(process.pid, "SIGTERM");
});

// The typed steps run in Git Bash, the shell the checklist is written for.
if (spawnSync("bash", ["-c", "true"]).status !== 0) {
  quit(2, "selftest types its steps into Git Bash: put bash on PATH (Git for Windows has it).");
}

/** A command typed into Git Bash, through pnpm, so the person's quoting is what gets tested. */
function typed(command) {
  const r = spawnSync("bash", ["-c", command], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
  });
  return { code: r.status ?? 1, out: r.stdout, all: `${r.stdout}${r.stderr}` };
}

/** `out` is what the script printed; `all` adds its notes on stderr, such as `(saved {token} …)`. */
function run(script, args) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], {
    // From the repo root, like a person: steps pass paths such as @fixtures/email/plain.eml.
    cwd: repoRoot,
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
    "new-email prints 201 and the conversation",
    () => run("new-email.mjs", []),
    (r) => r.code === 0 && /^201 created/.test(r.out),
  ],
  [
    "new-email --subject is also the body",
    () => run("new-email.mjs", ["--subject", "How much does gift wrap cost?"]),
    (r) =>
      r.code === 0 &&
      json(
        api("northwind:triage-bot", "GET", "v1/conversations/{conversation}"),
      ).messages[0].text.trim() === "How much does gift wrap cost?",
  ],
  [
    "new-email --subject --body",
    () => run("new-email.mjs", ["--subject", "Order question", "--body", "Do you ship to Norway?"]),
    (r) =>
      r.code === 0 &&
      json(
        api("northwind:triage-bot", "GET", "v1/conversations/{conversation}"),
      ).messages[0].text.trim() === "Do you ship to Norway?",
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
      json(api("northwind:triage-bot", "GET", "v1/conversations/{conversation}")).automated ===
        true,
  ],
  ["new-email xss", () => run("new-email.mjs", ["xss"]), (r) => r.code === 0],
  [
    "plain.eml sent twice: the second is a duplicate → 200",
    () => {
      api("inbound", "POST", "v1/inbound/email", "@fixtures/email/plain.eml");
      return api("inbound", "POST", "v1/inbound/email", "@fixtures/email/plain.eml");
    },
    (r) => status(r) === 200 && json(r).status === "duplicate",
  ],
  [
    "typed: pnpm new-email --subject with spaces",
    () => typed(`pnpm -s new-email --subject "Typed in bash, with spaces"`),
    (r) => r.code === 0 && /201 created: "Typed in bash, with spaces"/.test(r.all),
  ],
  [
    "typed: pnpm api with quoted JSON, braces and a placeholder",
    () =>
      typed(
        `pnpm -s api northwind:triage-bot PATCH v1/drafts/{draft} '{"body":"Typed: quotes, spaces and {braces}"}'`,
      ),
    (r) => /^200/m.test(r.all) && /Typed: quotes, spaces and {braces}/.test(r.all),
  ],
  [
    "a cut-off JSON body says why",
    () => api("northwind:triage-bot", "PATCH", "v1/drafts/{draft}", '{"body":"a '),
    (r) => r.code === 2 && /Put the body in a file and pass @file/.test(r.all),
  ],
  [
    "GET with a body says so",
    () => api("northwind:triage-bot", "GET", "v1/me", '{"x":1}'),
    (r) => r.code === 2 && /can't have a body/.test(r.all),
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
    "me as owner: every scope",
    () => api("owner", "GET", "v1/me"),
    (r) => status(r) === 200 && json(r).scopes.length === ownerScopes.length,
  ],
  [
    "me as triage-bot: agent, its seed scopes",
    () => api("northwind:triage-bot", "GET", "v1/me"),
    (r) =>
      status(r) === 200 &&
      json(r).actor.type === "agent" &&
      json(r).scopes.length === triageScopes.length,
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

  ["fresh conversation for section 3", () => run("new-email.mjs", []), (r) => r.code === 0],
  [
    "list open conversations",
    () => api("northwind:triage-bot", "GET", "v1/conversations?status=open"),
    (r) => status(r) === 200 && json(r).conversations.length > 0,
  ],
  [
    "limit=2 returns 2",
    () => api("northwind:triage-bot", "GET", "v1/conversations?status=open&limit=2"),
    (r) => status(r) === 200 && json(r).conversations.length === 2,
  ],
  [
    "read {conversation}",
    () => api("northwind:triage-bot", "GET", "v1/conversations/{conversation}"),
    (r) => status(r) === 200 && json(r).id === lastCreated().conversation,
  ],
  [
    "other workspace → 404",
    () => api("lumen:support-agent", "GET", "v1/conversations/{conversation}"),
    (r) => status(r) === 404,
  ],
  [
    "approver can't close → 403",
    () => api("northwind:approver-bot", "POST", "v1/conversations/{conversation}/close"),
    (r) => status(r) === 403,
  ],
  [
    "owner closes",
    () => api("owner", "POST", "v1/conversations/{conversation}/close"),
    (r) => status(r) === 200 && json(r).status === "closed",
  ],

  ["fresh conversation for section 4", () => run("new-email.mjs", []), (r) => r.code === 0],
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
  ["fresh conversation for discard", () => run("new-email.mjs", []), (r) => r.code === 0],
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
    () =>
      api(
        "northwind:triage-bot",
        "POST",
        "v1/conversations/{conversation}/drafts",
        '{"regenerate":true}',
      ),
    (r) => status(r) === 202,
  ],
  [
    "own reply → 201",
    () =>
      api(
        "northwind:triage-bot",
        "POST",
        "v1/conversations/{conversation}/drafts",
        '{"body":"My own reply"}',
      ),
    (r) => status(r) === 201,
  ],

  [
    "knowledge list",
    () => api("northwind:triage-bot", "GET", "v1/knowledge/sources"),
    (r) => status(r) === 200 && json(r).sources.every((s) => s.state.status === "ready"),
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
      api(
        "northwind:triage-bot",
        "POST",
        "v1/tokens",
        '{"name":"x","scopes":["conversations:read"]}',
      ),
    (r) => status(r) === 403 && json(r).error === "session_required",
  ],
  [
    "no admin tokens → 400",
    () => api("owner", "POST", "v1/tokens", '{"name":"x","scopes":["workspace:admin"]}'),
    (r) => status(r) === 400,
  ],
  [
    "stats-reader can't list conversations → 403",
    () => api("northwind:stats-reader", "GET", "v1/conversations"),
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
    () => {
      // Put back afterwards whoever it was: a person's hand test may rely on it.
      const before = api("northwind:triage-bot", "GET", "v1/workspace/shadow-mode");
      if (status(before) !== 200) return before;
      shadowRecipient = json(before).recipient;
      return api(
        "owner",
        "PATCH",
        "v1/workspace/shadow-mode",
        '{"recipient":"leo.brandt@northwind-cycles.test"}',
      );
    },
    (r) => status(r) === 200,
  ],
  [
    "shadow recipient back to how it was",
    () =>
      api(
        "owner",
        "PATCH",
        "v1/workspace/shadow-mode",
        JSON.stringify({ recipient: shadowRecipient }),
      ),
    (r) => {
      shadowRestored = status(r) === 200 && json(r).recipient === shadowRecipient;
      return shadowRestored;
    },
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
    "app:run uses this worktree",
    () => run("instance.mjs", ["run", "node", "-e", "console.log(process.env.HELPOS_PORT)"]),
    // Only a worktree gets its own port; the main checkout runs with .env as it is, so there
    // the command only has to run.
    (r) => r.code === 0 && (!inst.env.HELPOS_PORT || r.out.trim() === inst.env.HELPOS_PORT),
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
      typeof verdict === "string" ? verdict : result.all.trim().split("\n").slice(0, 4).join(" | ");
    process.stdout.write(`FAIL  ${name}\n      ${why}\n`);
  }
}
process.stdout.write(`\n${steps.length - failed}/${steps.length} passed\n`);
process.exitCode = failed ? 1 : 0;
