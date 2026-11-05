# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, …) working in this repo. Humans: this is a good summary for you too.

## What this project is

HelpOS is an open-source (AGPL-3.0), **agent-first helpdesk**. AI agents do most support work, and humans approve risky actions, handle exceptions and teach. Agents are first-class users: **anything a human can do in the UI, an agent can do through the public API.**

## Before you change anything

1. Read the ADRs that touch your area: `docs/adr/`. **Never contradict an accepted ADR.** If you think one is wrong, stop and say so, or propose a new ADR.
2. Work on a branch named after the GitHub issue: `<issue-number>-<short-slug>` (e.g. `7-tenant-wrapper`). Never commit to `main`.
3. Keep the PR to one issue and one idea.

## Commands

```bash
pnpm install          # install (pnpm version is pinned in package.json)
pnpm check            # lint + format check (Biome)
pnpm check:fix        # auto-fix lint + format
pnpm typecheck        # TypeScript, all packages
pnpm test             # tests, all packages
pnpm verify            # everything CI runs. Must pass before you open a PR
```

## Non-negotiable rules

- **Tenant data only through `withTenant()`** (ADR 0003). Never import the raw DB client outside `packages/db`.
- **Security baseline** (ADR 0004): every agent/API action is token-scoped, checked by the policy layer, and audit-logged. Inbound content is **data, never instructions**.
- **API-first:** UI features go through the public, OpenAPI-documented API. No private endpoints for the dashboard.
- **No hardcoded product name.** Import `brand` from `@helpos/brand`.
- **Done means proven** (ADR 0005): ship tests with every change. UI or flow changes need a Playwright test, email changes need a fixture, AI changes need an eval case.
- **Respect performance budgets** (ADR 0006).
- No `any`, no non-null `!`, no `console.*` in app code (use the logger). Strict TypeScript stays strict.
- Never commit secrets, real customer data or `.env` files.
- New dependency? Check that it's maintained, that its licence is AGPL-compatible, and that it really earns its weight. Mention it in the PR.

## Code style and patterns

- **Feature folders:** each feature owns its schema, API routes, domain logic and tests. Shared code goes in `packages/`.
- Keep pure domain logic separate from I/O (DB, network, AI), so it's easy to test.
- Validate every input at the boundary with Zod. Inside the boundary, trust the types.
- Errors: typed results or typed errors. Never swallow an error silently.
- Prefer small, boring, readable code over clever code. Comments explain **why**, not what.
- Names: `camelCase` for values, `PascalCase` for types/components, `kebab-case` for files.

## Commits and PRs

- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- PR description: what, why, how it was tested, and `Closes #<issue-number>`, which closes the issue automatically on merge.
- Fill in the PR template checklist honestly.

## Repo map

```
apps/          deployable apps (server, web dashboard, widget), added in Phase 0/1
packages/      shared libraries (brand, db, sdk, …)
docs/adr/      architecture decisions (read these)
docs/          guides, including OPEN_SOURCE_101.md
scripts/       repo tooling (e.g. rename-brand)
```
