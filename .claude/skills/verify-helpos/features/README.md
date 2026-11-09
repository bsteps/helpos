# HelpOS verification map

The maintained source for verifying what HelpOS users can see and do. Read this index, then the matching feature file as the recipe. Together the files cover every dashboard screen and all 33 operations in `/openapi.json`. When an endpoint or screen is added, add it here.

## Baseline preconditions

- Launched with `pnpm app:start`, and `pnpm app:doctor` exits 0.
- `pnpm app:password` has run, so `owner` (Maya Okafor, `maya.okafor@northwind-cycles.test`, password `northwind demo password`) can sign in.
- Seed data: workspace **Northwind Cycles** (mailbox `support@northwind-cycles.test`, owner Maya, member Leo) and **Lumen Analytics** (mailbox `help@lumen-analytics.test`). Both have tickets, drafts, knowledge sources and agent tokens.
- `V=.claude/skills/verify-helpos/scripts` and `A="pnpm api"` in the shell.

## Driving conventions

- API paths go without the leading slash (`v1/tickets`), because of Git Bash.
- Make your own test data with a unique subject (`Verify <thing> <timestamp>`) instead of mutating seeded tickets that other checks count on (the inbox's "approved unchanged" line reads the seeded drafts).
- Dashboard: roles, labels and `data-testid`, never CSS or position.
- New ticket IDs come back from the inbound call (`ticketId`). Draft IDs come from `GET v1/tickets/{id}/drafts`.

## Proof and skip reporting

- Proof for a browser step is a screenshot plus the API's view of the same state. For a mutation, add a second read of the stored value.
- Proof for a send is the Mailpit message: its recipients and text.
- Report a feature you couldn't reach with the attempted command and the missing precondition (for example "no GitHub token"). Never report it as verified through another path.

## Feature entry contract

Each file has an H1 and one paragraph, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright and api.mjs`, `Gotchas`.

## Features

- [Sign-in and sessions](./auth.md): login, set password, sign out, who-am-I. 4 endpoints.
- [Inbound email](./inbound-email.md): how customer email becomes a ticket. 1 endpoint.
- [Inbox and tickets](./inbox-and-tickets.md): list, open, close. 3 endpoints.
- [Drafts and approval](./drafts-and-approval.md): the AI draft, edit, approve and send, discard, retry, redraft. 6 endpoints. The main journey.
- [Knowledge](./knowledge.md): sources the AI drafts from. API only. 5 endpoints.
- [Agent tokens](./agent-tokens.md): create, list, revoke, and scope enforcement. API only. 3 endpoints.
- [GitHub loop](./github-loop.md): connect a repo, ticket to issue, issue closed to "fixed" draft. 7 endpoints.
- [Workspace controls](./workspace-controls.md): shadow mode, draft stats, AI budget. 4 endpoints.
