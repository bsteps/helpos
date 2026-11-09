# GitHub loop

A workspace owner connects one GitHub repo with a fine-grained token. From a ticket, a human or agent asks the AI for an issue title and body, edits them, and creates the issue. When the issue is closed as completed, GitHub's webhook makes a "fixed" draft on the ticket, which is approved like any reply.

## Sub-features

- `gh-connect` connects a repo after checking the token with GitHub. It stores the token encrypted and shows the webhook URL and secret once.
- `gh-status` reports whether a repo is connected, which one, and the webhook URL.
- `gh-rotate` makes a new webhook secret without the token.
- `gh-disconnect` removes the integration.
- `gh-issue-draft` has the AI suggest an issue title and body, cleaned of links, emails and mentions.
- `gh-issue-create` opens the issue and links it to the ticket. A retry never opens a second issue.
- `gh-webhook` turns a signed `issues.closed` (completed) event into a `fixed` draft. A reopen withdraws it.

## How to get to it (user POV)

- Dashboard `Settings` → card `GitHub`: fields `Repository` (`owner/name`) and `Personal access token` (`github_pat_…`), buttons `Connect`, `New webhook secret`, `Disconnect`, and the values `webhook-url` and `webhook-secret`. Non-owners see `Only workspace owners can change this.`
- Ticket page: `Create GitHub issue` → textboxes `Title` and `Description` → `Create issue`. Then a link `owner/name#N`. Later, the region `Fix notice`.
- API: `GET`/`PUT`/`DELETE v1/integrations/github`, `POST v1/integrations/github/webhook-secret`, `POST v1/tickets/{id}/github-issue/draft`, `POST v1/tickets/{id}/github-issue`, `POST v1/integrations/github/webhook?workspace=<id>` (from GitHub, signed `X-Hub-Signature-256`).

## Driving it with Playwright and api.mjs

Preconditions: baseline, **plus a real throwaway GitHub repo and a fine-grained token with Issues read/write on it**. Connecting checks the token with GitHub, so without one, only the read and refusal steps can run. Report the rest as unreachable.

- **Status.** `pnpm api owner GET v1/integrations/github` returns `{"connected": false, ...}` on fresh seed data.
- **Refusals (no token needed).** `pnpm api owner PUT v1/integrations/github '{"repo":"a/b","token":"ghp_classic"}'` returns `400` (fine-grained tokens only). As `northwind:triage-bot` the same call returns `403`. The `Settings` page signed in as Leo (member) shows `Only workspace owners can change this.`
- **Connect.** In `Settings`, fill `Repository` and `Personal access token`, then click `Connect`. `webhook-url` and `webhook-secret` appear once. `GET v1/integrations/github` shows `connected: true` and the repo.
- **Issue.** On a ticket, click `Create GitHub issue`. `Title` and `Description` fill in from the AI. Click `Create issue`. A link `<repo>#N` appears, and the issue exists on GitHub with only a title and body (no labels or assignees). An agent can do the same with a token holding `tickets:read` and `github:write`: `POST v1/tickets/<id>/github-issue/draft`, then `POST v1/tickets/<id>/github-issue '{"title","body"}'`.
- **Webhook.** GitHub can't reach localhost. Sign the event yourself: compute the HMAC-SHA256 of the exact body with the webhook secret, then `POST v1/integrations/github/webhook?workspace=<workspace id>` with `X-GitHub-Event: issues`, `X-Hub-Signature-256: sha256=<hex>`, and a body with `action: "closed"`, `issue.state_reason: "completed"`, the issue number and `repository.full_name`. The ticket gets a `kind: "fixed"` pending draft, and the page shows `Fix notice`. A wrong signature returns `401`.
- **Rotate and disconnect.** `New webhook secret` shows a new secret, and the old one now gets `401`. `Disconnect` returns the card to the connect form.

## Gotchas

- The e2e suite runs this whole flow against a fake GitHub (`apps/web/e2e/github.spec.ts`). Locally it needs a real one.
- Connecting needs `HELPOS_ENCRYPTION_KEY`. `pnpm dev` adds a random one to `.env` the first time.
- Only an issue closed as `completed` makes a fixed draft. `not_planned` and `duplicate` make none.
- The workspace id is in `pnpm api owner GET v1/me` (`workspace.id`).
- Use a throwaway repo: issues you create are real.
