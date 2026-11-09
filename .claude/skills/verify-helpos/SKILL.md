---
name: verify-helpos
description: Drive this checkout's real HelpOS (the dashboard in a browser, and the agent API with hos_ tokens) to prove a feature works, and capture evidence. Use after changing server, web or worker behavior, before claiming a flow works, or when asked to run, check or demo the app. Covers launch, a doctor check, scripted journeys and a feature map of every screen and endpoint.
---

# Verify HelpOS

HelpOS has two user surfaces. People use the **dashboard** (React app). Agents and integrations use the **agent API** (`/v1/...`, OpenAPI at `/openapi.json`). Email comes in through `POST /v1/inbound/email` and goes out through a background worker to SMTP, which Mailpit catches locally. Prove a change on the surface its users touch, and check the side effect (a row, a sent email), not just the screen.

All helpers live in `.claude/skills/verify-helpos/scripts/`. Run them from the repo root. Call it `$V` below:

```bash
V=.claude/skills/verify-helpos/scripts
```

## Launch

1. Wait for worktree setup: `.helpos/setup-done` must exist (`.helpos/setup-running` means wait, `.helpos/setup-failed` means read it and rerun `pnpm setup:worktree`). A worktree without `node_modules` never ran setup: run `node scripts/setup-worktree.mjs` (about a minute).
2. Docker must be running. `pnpm dev` starts the shared Postgres and Mailpit containers.
3. Start the app as a **background task**: `pnpm app:start`. It runs `pnpm dev`, which migrates and (first time only) seeds this checkout's own database, then serves the API and the dashboard on ports derived from the checkout path. When `.env` has no embedding settings and Ollama answers on `:11434`, it turns on local embeddings (`qwen3-embedding:0.6b`, 1024 dimensions) so knowledge search works.
4. Ready means usable, not just "port open": `pnpm app:doctor --wait 120` exits 0.
5. Once per database: `pnpm app:password`. It gives the Northwind owner the demo password through the real one-time link flow. Safe to rerun.

`pnpm app:info` prints the URLs and database for this checkout. To run a repo CLI against this checkout's database (not the shared one in `.env`), wrap it: `pnpm app:run pnpm helpos:token ...`.

## Doctor

`pnpm app:doctor` is read-only. Run it first, and again whenever anything looks off. It checks:

- API and dashboard ports are held by HelpOS processes (not a stranger).
- `/health` reports the database ok.
- The dashboard proxies `/v1` to the API.
- Mailpit answers.
- The inbound secret is set.
- The seed tokens work.

Warnings (`warn`) name features that will not work: knowledge sources still `pending` (no embeddings), or the owner can't sign in (run `owner-password.mjs`). `FAIL` means don't drive this instance until it's fixed.

## Drive

**Agent API.** `pnpm api <as> <METHOD> v1/<path> [json | @file]` prints the status and JSON and exits 0 on 2xx. Write the path **without** a leading slash: Git Bash rewrites `/v1/...` into a Windows path. `<as>` is one of these callers:

| `<as>` | Who | Scopes |
| --- | --- | --- |
| `owner` | Maya, Northwind owner, session cookie | all, including `workspace:admin` |
| `northwind:triage-bot` | agent | `tickets:read`, `drafts:write`, `knowledge:read` |
| `northwind:approver-bot` | agent | `tickets:read`, `drafts:approve` |
| `northwind:stats-reader` | agent | `stats:read` |
| `lumen:support-agent` | agent in the *other* workspace | use it to prove tenant isolation |
| `hos_…` | a token you minted with `owner POST v1/tokens` | what you gave it |
| `inbound` | the email provider | body `@fixtures/email/<name>.eml`; `support@acme.test` is swapped for the Northwind mailbox |
| `none` | nobody | proves auth is required |

**Placeholders instead of copied IDs.** `api.mjs` and `new-email.mjs` remember what they last created in `.helpos/verify/last.json`. Write `{ticket}`, `{draft}` (that ticket's draft, waiting for the AI if needed), `{draftBody}` (its exact text as a JSON string, for `'{"body":{draftBody}}'`), `{token}`, `{tokenId}` or `{source}` in the path, body or `<as>`. Never pipe `api.mjs` output into another `node` command: Git Bash runs `node` through `winpty`, which breaks pipes into it.

No seed token has `tickets:write`, `knowledge:write` or `github:write` in Northwind. Use `owner`, or mint a token.

**Dashboard.** Playwright from `apps/web` (browsers are already installed for it). Use roles and labels. They are stable, and the e2e suite in `apps/web/e2e/` uses the same ones:

```js
const { chromium } = await import("@playwright/test");
// page.getByLabel("Email") / ("Password"), getByRole("button", { name: "Sign in" }),
// getByRole("heading", { name: "Inbox" }), getByTestId("draft-body"), "Approve & send"
```

`$V/journey-reply.mjs` is a complete example of both surfaces. Copy its shape for a new journey.

**New customer email.** `pnpm new-email [fixture] [--subject "text"] [--body "text"]` sends a sample from `fixtures/email/` (default `plain`) as a brand-new ticket: a fresh Message-ID and a unique subject, so it is never a duplicate. With the default sample, `--subject` alone is also the body. `--body` works only on single-part plain-text samples. The last line it prints is the ticket ID.

**GitHub webhook.** `pnpm github-webhook <issueNumber> --secret <webhook secret> [--action closed|reopened] [--reason completed|not_planned|duplicate] [--bad-signature]` signs and sends an `issues` event for the connected repo, since GitHub can't reach localhost.

**Agent approval.** `pnpm approve-draft <ticketId | new>` reads the pending draft as `triage-bot`, approves that exact text as `approver-bot`, and waits for `sent`. `new` sends a fresh customer email first. Use it instead of piping `api.mjs` into other commands: Git Bash runs `node` through `winpty`, which breaks pipes into `node`.

**Main journey.** `pnpm app:journey --via web` or `--via api`. It sends a customer email, waits for the ticket and the real AI draft, approves it (owner in the browser, or `approver-bot` over the API), waits for `sent`, then checks Mailpit: the reply went to the shadow recipient only, with the approved text.

**Feature map.** `features/README.md` lists every screen and endpoint with a recipe. Read the feature file before driving that feature, and cover every entry point it lists.

## Selftest

`pnpm app:selftest [--with-browser]` runs every terminal step of the hand-test checklist through the real helpers and checks each result (61 steps with the browser). Run it after changing any helper or checklist step, before handing steps to a person. A step that fails here would have failed for them. A run writes about 15 AI drafts (roughly 20,000 tokens; `pnpm app:start` raises this instance's daily cap to 1,000,000), and it refuses to start below 30,000. Each run also leaves about a dozen tickets in the Inbox, so don't run it in the middle of someone's hand test. Scripts stop with `quit()` from `instance.mjs`, never `process.exit()`: exiting right after a fetch crashes Node on Windows (exit code 127).

## Evidence

- Journeys write to `.helpos/verify/<timestamp>-<journey>/`: `steps.json` (each action and what was observed), screenshots for browser steps, and `mail.json` (the caught email). `FAILED.txt` and `failure.png` appear on failure. `.helpos/` is git-ignored.
- For an ad hoc check, save the `api.mjs` output there yourself: `pnpm api ... > .helpos/verify/<name>.txt`.
- Proof standards:
  - Drive the real user path. Use the public API or the dashboard, never the database or internal functions.
  - Capture the action and the resulting state.
  - Verify side effects: the draft's status over the API, the email in Mailpit (`http://localhost:8025/api/v1/search?query=subject:"..."`).
  - The AI is real, not mocked: drafts use the model in `.env`. Assert structure (a pending draft exists, it cites a source), not exact wording.
- **Shadow mode is on and locked** locally (`HELPOS_ALLOW_SHADOW_MODE_OFF=false`). Every reply goes to the owner, never to the customer, which is what makes sending safe to test. A reply that reaches a customer address is a failure.

## Cleanup

`pnpm app:stop` stops only the processes `launch.mjs` started. Once the app is up, `launch.mjs` records their process IDs in `.helpos/verify/instance.json`. Any other process on this checkout's ports is left running and reported, and cleanup exits 1. That covers a `pnpm dev` someone started by hand, another worktree that hashed to the same ports, or another project. Cleanup also exits 1 if a port is still held afterwards. Stopping the background `launch.mjs` task alone is **not enough on Windows**: the server and Vite keep running and hold the ports. Run cleanup after every run, including failed ones. The background `launch.mjs` task then ends with exit code 1. That is expected, since cleanup stopped it.

Cleanup never removes `.helpos/verify/` (the evidence) or the database. To start over with fresh demo data, drop this checkout's database (`pnpm app:info` names it) and delete `.helpos/seeded`. Then launch again.

## Isolation

Each worktree gets its own database (`helpos_wt_<hash>`) and ports (API 20001-20999, dashboard 21001-21999). Two worktrees can run side by side. Postgres and Mailpit are **shared** containers. Mailpit shows every checkout's mail, so always find mail by a unique subject. Never drive an instance that `doctor.mjs` says is not HelpOS. Never point a worktree at a non-local database: `pnpm dev` refuses, and so does `instance.mjs`.
