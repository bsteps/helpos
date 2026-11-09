# Agent tokens

Agents call the API with a `hos_` token. A token belongs to one workspace, holds a set of scopes, and is revoked rather than deleted, so the audit log can always name the agent. Only a workspace owner, signed in as a human, can create or revoke tokens. A token can never create another token or hold `workspace:admin`.

## Sub-features

- `token-create` makes a token with chosen scopes. The secret is shown once.
- `token-list` lists tokens without their secrets, revoked ones included.
- `token-revoke` revokes a token, after which it gets 401.
- `token-scopes` refuses a call outside the token's scopes with 403.
- `token-tenant` makes another workspace's data look like it doesn't exist (404).

## How to get to it (user POV)

- API only, as a signed-in owner: `POST v1/tokens` `{"name","scopes"}`, `GET v1/tokens`, `DELETE v1/tokens/{id}`.
- Operator CLI: `pnpm app:run pnpm helpos:token ...`.

## Driving it with Playwright and api.mjs

Preconditions: baseline.

- **Create.** `pnpm api owner POST v1/tokens '{"name":"verify-kb","scopes":["knowledge:read","knowledge:write"]}'` returns `201` with `token: "hos_…"`. Save it to a file in `.helpos/verify/`. Never print it into a PR.
- **List.** `pnpm api owner GET v1/tokens` shows `verify-kb` with `revokedAt: null` and no secret.
- **Use.** `pnpm api <hos_token> GET v1/knowledge/sources` returns `200`.
- **Revoke.** `pnpm api owner DELETE v1/tokens/<id>` returns `204`. Then `pnpm api <hos_token> GET v1/knowledge/sources` returns `401 unauthorized`, and `GET v1/tokens` shows `revokedAt` set.
- **Token can't mint.** `pnpm api northwind:triage-bot POST v1/tokens '{"name":"x","scopes":["tickets:read"]}'` returns `403 session_required`.
- **No admin tokens.** `pnpm api owner POST v1/tokens '{"name":"x","scopes":["workspace:admin"]}'` is refused.
- **Scopes.** `pnpm api northwind:stats-reader GET v1/tickets` returns `403 forbidden`.
- **Tenant.** `pnpm api lumen:support-agent GET v1/tickets/<northwind ticket id>` returns `404`.

## Gotchas

- Seed tokens are deterministic and public (`apps/server/src/seed/demo-data.ts`). They exist only in local databases, and the seed refuses production.
- `old-import-script` is seeded already revoked. Use it to check that revoked tokens show in the list.
- Revoke every token you minted before you finish.
