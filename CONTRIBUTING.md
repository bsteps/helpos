# Contributing to HelpOS

Thanks for helping! This guide gets you from zero to a merged pull request.

New to open source? Read [docs/OPEN_SOURCE_101.md](docs/OPEN_SOURCE_101.md) first. It explains issues, branches, PRs and reviews.

## 1. Set up (about 5 minutes)

You need **Node.js 24+**, **Git**, and **Docker** (it runs Postgres and Mailpit locally).

```bash
git clone https://github.com/bsteps/helpos.git
cd helpos
corepack enable        # uses the pnpm version pinned in package.json
pnpm install
pnpm verify             # runs every check, which should pass on a fresh clone (Docker must be running)
pnpm dev                # starts Postgres + Mailpit, applies migrations, runs the server
```

Then open <http://localhost:3000/health> (should say `ok`) and <http://localhost:8025> (Mailpit, catches every email the app sends). Settings live in `.env`, created from `.env.example` on first run.

## 2. Find something to work on

- Issues labelled **`good first issue`** are a good start.
- All work is tracked in **GitHub Issues**, grouped into the **MVP** milestone (what we build now) and **Later**, and shown on the [HelpOS Roadmap board](https://github.com/users/bsteps/projects/1). Accepted work has a "Done when" checklist.
- For anything bigger than a small fix, **comment on the issue first**, so nobody duplicates work.

## 3. Make your change

```bash
git switch -c 42-short-description    # branch named after the issue
# …make changes…
pnpm check:fix                            # format + lint
pnpm verify                                # typecheck + tests
git commit -m "fix: keep Outlook replies in the same thread"
git push -u origin 42-short-description
```

Rules that matter most (full list in [AGENTS.md](AGENTS.md)):

- **Every change ships with tests.** We don't rely on manual testing ([ADR 0005](docs/adr/0005-verification-over-manual-testing.md)).
- **Tenant data only through `withTenant()`** ([ADR 0003](docs/adr/0003-tenant-isolation.md)).
- **Agent and API actions are scoped, policy-checked and audit-logged** ([ADR 0004](docs/adr/0004-security-baseline.md)).
- Changing architecture? Write an ADR in `docs/adr/` first.

## 4. Open a pull request

- PR title in [Conventional Commits](https://www.conventionalcommits.org) form: `feat: …`, `fix: …`, `docs: …`.
- Fill in the PR template: what, why, how you tested it.
- **First PR?** The CLA Assistant bot will ask you to sign [CLA.md](CLA.md). It takes one click.
- CI must be green, and a maintainer will review your PR. (An automated AI review is planned in #42.)
- We **squash-merge**, so your PR becomes one clean commit on `main`.

## Using AI coding agents

Welcome and encouraged. You are still responsible for every line you submit: read it, understand it, and make sure it's tested. Point your agent at [AGENTS.md](AGENTS.md).

### The maintainers' loop with T3 Code

One issue = one T3 Code thread = one worktree = one PR.

1. Open an issue and click **▶ Work on this in T3 Code** in the bot's comment. Maintainers' issues get the link automatically; other issues get it when a maintainer adds the `ready` label.
2. T3 Code opens a new thread with the task ready. Set the project to start threads in a **new worktree**, so every issue gets its own branch and parallel threads never collide. Press Send.
3. The agent reads the issue, builds the change with tests, and opens a PR that says `Closes #<n>`.
4. Review the diff and the checks (not the app by hand, see ADR 0005), then squash-merge.
5. Archive the thread. Threads are an inbox: done means cleared.

Run several threads in parallel, but merge PRs that touch the database or security one at a time.

## Code of Conduct

By taking part you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).
