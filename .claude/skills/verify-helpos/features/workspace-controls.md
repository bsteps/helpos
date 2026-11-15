# Workspace controls

Settings that keep a workspace safe and visible. Shadow mode sends every reply to a test recipient instead of the customer, and turning it off is locked unless the server allows it. The AI budget caps a day's model use, and pauses drafting when it runs out.

## Sub-features

- `shadow-read` shows whether shadow mode is on, and the recipient.
- `shadow-change` sets the recipient. Turning shadow mode off is refused unless `HELPOS_ALLOW_SHADOW_MODE_OFF=true`.
- `ai-usage` shows today's tokens, the daily budget, what remains, and `paused`.

## How to get to it (user POV)

- API: `GET`/`PATCH v1/workspace/shadow-mode`, `GET v1/ai-usage`.
- Dashboard: `AI paused` badges and alerts when the budget is spent.
- Operator CLI: `pnpm app:run pnpm helpos:ai-budget`.

## Driving it with Playwright and api.mjs

Preconditions: baseline.

- **Shadow read.** `pnpm api northwind:triage-bot GET v1/workspace/shadow-mode` returns `{"enabled": true, "recipient": "maya.okafor@northwind-cycles.test"}`.
- **Shadow locked.** `pnpm api owner PATCH v1/workspace/shadow-mode '{"enabled":false}'` returns `409 shadow_mode_locked`. As `northwind:triage-bot` the same call returns `403`.
- **Shadow recipient.** `pnpm api owner PATCH v1/workspace/shadow-mode '{"recipient":"leo.brandt@northwind-cycles.test"}'` returns `200`. The next approved reply arrives in Mailpit to Leo. Set it back to Maya afterwards.
- **AI usage.** `pnpm api northwind:triage-bot GET v1/ai-usage` shows `calls` and `totalTokens` growing after each AI draft, and `paused: false`.

## Gotchas

- Never set `HELPOS_ALLOW_SHADOW_MODE_OFF=true` to test turning shadow mode off unless every customer address in the database is fake. The seed's are (`.test`), but a copied database might not be.
- Exhausting the AI budget to see `AI paused` costs real tokens. Lower `HELPOS_AI_DAILY_TOKEN_BUDGET` for this checkout's run instead.
