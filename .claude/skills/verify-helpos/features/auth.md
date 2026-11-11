# Sign-in and sessions

People sign in with email and password. There is no sign-up. An operator creates the workspace and owner with `pnpm helpos:init`, which prints a one-time link to set the password. A signed-out visitor who opens a conversation link is sent to sign in, then back to that conversation.

## Sub-features

- `auth-set-password` sets a password from a one-time link, and the link works once.
- `auth-sign-in` starts a session. A wrong password gets the same answer as an unknown email.
- `auth-redirect` brings a signed-out deep link back to its page after sign-in.
- `auth-sign-out` ends the session.
- `auth-me` tells any caller (human or agent) who it is, which workspace, and which scopes.

## How to get to it (user POV)

- Dashboard `/set-password#token=...` (the link from `helpos:init`).
- Dashboard `/login`, and any signed-in page while signed out.
- `Sign out` in the header.
- API: `POST v1/auth/password`, `POST v1/auth/sign-in`, `POST v1/auth/sign-out`, `GET v1/me`.

## Driving it with Playwright and api.mjs

Preconditions: baseline.

- **Set password (link flow).** Run `pnpm app:password`. The first run prints `password set`, later runs print `password already set`. To see the page itself, run `pnpm app:run pnpm helpos:init --workspace "Northwind Cycles" --mailbox support@northwind-cycles.test --owner leo.brandt@northwind-cycles.test` for a user with no password yet, then open the printed link. You see the heading `Set your HelpOS password` with the fields `New password` and `Repeat it` and the button `Set password`, which leads to `Your password is set. Sign in with it.`
- **Used link.** Open the same full link again. The form still shows, because the page reads the token and strips it from the URL without asking the server. Submit any valid password. You see `This link has expired or was already used. Ask for a new one.`, and the server answered `400 invalid_token`.
- **No token.** Open `/set-password` without `#token=...`, or reload after the page stripped it. You see `This page needs the full link you were sent. Open that link again.` and no form.
- **Sign in.** At `/login`, fill `Email` and `Password`, then click `Sign in`. The heading `Inbox` appears and the header shows `Northwind Cycles`. API: `pnpm api none POST v1/auth/sign-in '{"email":"maya.okafor@northwind-cycles.test","password":"northwind demo password"}'` returns `204` with a `Set-Cookie`.
- **Wrong password.** The page shows `Wrong email or password.`. The API answers `401 invalid_credentials`, the same as for an unknown email.
- **Deep link.** Signed out, open `/conversations/<id>?from=notice`. You land on `/login?redirect=...`. After sign-in the URL is `/conversations/<id>?from=notice`.
- **Who am I.** `pnpm api owner GET v1/me` returns `actor.type` `user` with all 9 scopes. `pnpm api northwind:triage-bot GET v1/me` returns `actor.type` `agent` with its 3 scopes. `pnpm api none GET v1/me` returns `401`.
- **Sign out.** Click `Sign out`. You are back on `/login`, and opening `/` sends you to `/login` again.

## Gotchas

- Session writes check `Origin`. A cookie request without the dashboard's origin is refused as CSRF. `api.mjs` sets it for you, but a raw curl doesn't.
- Setting a password signs out that user's other sessions.
- Leo is a `member`, so he has every scope except `workspace:admin`. Use him to prove that admin-only actions are refused for non-owners.
- `pnpm helpos:init` run without `instance.mjs run --` writes to the shared `.env` database, not this worktree's.
