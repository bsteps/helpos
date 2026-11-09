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
3. Start the app as a **background task**: `node $V/launch.mjs`. It runs `pnpm dev`, which migrates and (first time only) seeds this checkout's own database, then serves the API and the dashboard on ports derived from the checkout path. When `.env` has no embedding settings and Ollama answers on `:11434`, it turns on local embeddings (`qwen3-embedding:0.6b`, 1024 dimensions) so knowledge search works.
4. Ready means usable, not just "port open": `node $V/doctor.mjs --wait 120` exits 0.
5. Once per database: `node $V/owner-password.mjs`. It gives the Northwind owner the demo password through the real one-time link flow. Safe to rerun.

`node $V/instance.mjs` prints the URLs and database for this checkout. To run a repo CLI against this checkout's database (not the shared one in `.env`), wrap it: `node $V/instance.mjs run -- pnpm helpos:token ...`.

## Doctor

`node $V/doctor.mjs` is read-only. Run it first, and again whenever anything looks off. It checks:

- API and dashboard ports are held by HelpOS processes (not a stranger).
- `/health` reports the database ok.
- The dashboard proxies `/v1` to the API.
- Mailpit answers.
- The inbound secret is set.
- The seed tokens work.

Warnings (`warn`) name features that will not work: knowledge sources still `pending` (no embeddings), or the owner can't sign in (run `owner-password.mjs`). `FAIL` means don't drive this instance until it's fixed.

## Drive

**Agent API.** `node $V/api.mjs <as> <METHOD> v1/<path> [json | @file]` prints the status and JSON and exits 0 on 2xx. Write the path **without** a leading slash: Git Bash rewrites `/v1/...` into a Windows path. `<as>` is one of these callers:

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

No seed token has `tickets:write`, `knowledge:write` or `github:write` in Northwind. Use `owner`, or mint a token.

**Dashboard.** Playwright from `apps/web` (browsers are already installed for it). Use roles and labels. They are stable, and the e2e suite in `apps/web/e2e/` uses the same ones:

```js
import { createRequire } from "node:module";
const { chromium } = createRequire(process.cwd() + "/apps/web/package.json")("@playwright/test");
// page.getByLabel("Email") / ("Password"), getByRole("button", { name: "Sign in" }),
// getByRole("heading", { name: "Inbox" }), getByTestId("draft-body"), "Approve & send"
```

`$V/journey-reply.mjs` is a complete example of both surfaces. Copy its shape for a new journey.

**Main journey.** `node $V/journey-reply.mjs --via web` or `--via api`. It sends a customer email, waits for the ticket and the real AI draft, approves it (owner in the browser, or `approver-bot` over the API), waits for `sent`, then checks Mailpit: the reply went to the shadow recipient only, with the approved text.

**Feature map.** `features/README.md` lists every screen and endpoint with a recipe. Read the feature file before driving that feature, and cover every entry point it lists.

## Evidence

- Journeys write to `.helpos/verify/<timestamp>-<journey>/`: `steps.json` (each action and what was observed), screenshots for browser steps, and `mail.json` (the caught email). `FAILED.txt` and `failure.png` appear on failure. `.helpos/` is git-ignored.
- For an ad hoc check, save the `api.mjs` output there yourself: `node $V/api.mjs ... > .helpos/verify/<name>.txt`.
- Proof standards:
  - Drive the real user path. Use the public API or the dashboard, never the database or internal functions.
  - Capture the action and the resulting state.
  - Verify side effects: the draft's status over the API, the email in Mailpit (`http://localhost:8025/api/v1/search?query=subject:"..."`).
  - The AI is real, not mocked: drafts use the model in `.env`. Assert structure (a pending draft exists, it cites a source), not exact wording.
- **Shadow mode is on and locked** locally (`HELPOS_ALLOW_SHADOW_MODE_OFF=false`). Every reply goes to the owner, never to the customer, which is what makes sending safe to test. A reply that reaches a customer address is a failure.

## Cleanup

`node $V/cleanup.mjs` stops only the processes `launch.mjs` started. Once the app is up, `launch.mjs` records their process IDs in `.helpos/verify/instance.json`. Any other process on this checkout's ports is left running and reported, and cleanup exits 1. That covers a `pnpm dev` someone started by hand, another worktree that hashed to the same ports, or another project. Cleanup also exits 1 if a port is still held afterwards. Stopping the background `launch.mjs` task alone is **not enough on Windows**: the server and Vite keep running and hold the ports. Run cleanup after every run, including failed ones. The background `launch.mjs` task then ends with exit code 1. That is expected, since cleanup stopped it.

Cleanup never removes `.helpos/verify/` (the evidence) or the database. To start over with fresh demo data, drop this checkout's database (`node $V/instance.mjs` names it) and delete `.helpos/seeded`. Then launch again.

## Isolation

Each worktree gets its own database (`helpos_wt_<hash>`) and ports (API 20001-20999, dashboard 21001-21999). Two worktrees can run side by side. Postgres and Mailpit are **shared** containers. Mailpit shows every checkout's mail, so always find mail by a unique subject. Never drive an instance that `doctor.mjs` says is not HelpOS. Never point a worktree at a non-local database: `pnpm dev` refuses, and so does `instance.mjs`.
