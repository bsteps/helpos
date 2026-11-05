# Open Source 101: how this repo works

A practical guide for maintainers and first-time contributors. Read it once, then come back when you need it.

---

## 1. The big picture

```
Idea or bug
   ↓
Issue                 ← everyone can see and discuss it
   ↓
Branch                ← your own copy of the code to work on
   ↓
Commits               ← small saved steps, each with a message
   ↓
Pull Request (PR)     ← "please merge my branch into main"
   ↓
CI checks + review    ← robots test it, a human reviews it
   ↓
Merge into main       ← the change is now part of HelpOS
   ↓
Release (v0.3.0)      ← tagged version, changelog, Docker image
```

**Rule #1: nobody pushes directly to `main`, not even the maintainer.** Every change goes through a PR. That's how a project stays reliable when many people (and AI agents) work on it.

---

## 2. The words you'll hear

| Word                            | Meaning                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Repository (repo)**           | The project folder plus its full history, hosted on GitHub                                                           |
| **`main`**                      | The official, always-working version of the code                                                                     |
| **Branch**                      | A parallel copy where you make changes without touching `main`                                                       |
| **Fork**                        | Your own copy of someone else's repo. Outside contributors use forks, because they can't create branches in our repo |
| **Commit**                      | A saved snapshot with a message describing the change                                                                |
| **Pull Request (PR)**           | A request to merge your branch into `main`. Discussion and review happen here                                        |
| **Review**                      | Someone reads your PR and approves it or requests changes                                                            |
| **CI (Continuous Integration)** | Robots (GitHub Actions) that run tests and checks on every PR                                                        |
| **Merge**                       | Accepting the PR, so its commits land in `main`                                                                      |
| **Issue**                       | A bug report, feature request or task                                                                                |
| **Label**                       | A tag on issues and PRs: `bug`, `good first issue`, `needs-triage`                                                   |
| **Release / tag**               | A named version such as `v0.3.0`                                                                                     |
| **Maintainer**                  | Someone with permission to review and merge                                                                          |
| **Contributor**                 | Anyone who opens issues or PRs                                                                                       |

---

## 3. Your daily workflow (maintainers, same repo)

```bash
# 1. Start from an up-to-date main
git switch main
git pull

# 2. Create a branch named after what you're doing
git switch -c docs/readme-vision

# 3. Make changes, then save them as a commit
git add README.md
git commit -m "docs: write the project vision in README"

# 4. Push the branch to GitHub
git push -u origin docs/readme-vision

# 5. Open a pull request
gh pr create --fill

# 6. Wait for green CI checks and a review, then merge
gh pr merge --squash --delete-branch
```

**Outside contributors** do the same, except step 2 starts with _Fork_ on GitHub and `git clone` of their fork.

---

## 4. Commit messages: Conventional Commits

Format: `type: short description in present tense`

| Type        | Use for                                              |
| ----------- | ---------------------------------------------------- |
| `feat:`     | A new feature → **minor** version bump (0.**3**.0)   |
| `fix:`      | A bug fix → **patch** version bump (0.3.**1**)       |
| `docs:`     | Documentation only                                   |
| `refactor:` | Code change that doesn't change behaviour            |
| `test:`     | Adding or fixing tests                               |
| `chore:`    | Tooling, dependencies, config                        |
| `feat!:`    | Breaking change → **major** version bump (after 1.0) |

Good: `fix: keep Outlook replies in the same thread`
Bad: `fixed stuff`, `wip`, `update`

Why bother? Release notes and version numbers are generated **automatically** from these messages.

---

## 5. What makes a good PR

- **Small.** One idea per PR. 50–300 lines is easy to review; 3,000 lines gets rubber-stamped or ignored.
- **Linked.** "Closes #42" in the description automatically closes the issue when the PR merges.
- **Explained.** What, why, and how you tested it (the PR template asks for these).
- **Green.** All CI checks pass before you ask for review.

### Reviewing someone's PR

- Be kind and specific. Write "This could leak another tenant's data if X; could we use `withTenant()`?", not "this is wrong".
- Prefix nitpicks with `nit:` so the author knows they're optional.
- Approve, Comment, or Request changes.

---

## 6. The files in this repo and why they exist

| File                               | Purpose                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `README.md`                        | First impression: what HelpOS is, how to run it                                     |
| `LICENSE`                          | AGPL-3.0: the legal terms for using the code                                        |
| `CLA.md`                           | Contributor License Agreement, signed once per contributor by a bot comment         |
| `CONTRIBUTING.md`                  | How to set up, code style, how to submit PRs                                        |
| `CODE_OF_CONDUCT.md`               | Expected behaviour; keeps the community safe                                        |
| `SECURITY.md`                      | How to report vulnerabilities **privately**                                         |
| `AGENTS.md`                        | Instructions for AI coding agents (Claude Code, Codex, Cursor) working in this repo |
| `docs/adr/`                        | Architecture Decision Records: _why_ we chose things                                |
| `.github/ISSUE_TEMPLATE/`          | Forms that make bug reports useful                                                  |
| `.github/pull_request_template.md` | Checklist shown on every PR                                                         |
| `.github/CODEOWNERS`               | Who must review changes                                                             |
| `.github/workflows/`               | CI robots: tests, CLA, dependency review                                            |
| `.github/dependabot.yml`           | Opens PRs automatically to update dependencies                                      |

---

## 7. Licence and CLA in one minute

- **AGPL-3.0:** anyone may use, modify and self-host HelpOS for free. If they run a _modified_ version as a service for others, they must publish their changes. This stops someone taking HelpOS closed and competing with it.
- **CLA:** contributors keep their copyright but let the maintainers also license their code in other ways (for example a commercial licence). The bot asks on your first PR; you sign by commenting one sentence.
- **Our hosted billing code** lives in a separate private repo (`helpos-cloud`). The helpdesk itself is fully open.

---

## 8. Security etiquette

- **Never** commit secrets (`.env`, API keys). `.gitignore` blocks the common ones, and GitHub secret scanning is on.
- **Never** discuss a vulnerability in a public issue. Use the private report button (see `SECURITY.md`).
- Dependencies are reviewed automatically on every PR for known vulnerabilities and incompatible licences.

---

## 9. Releases

1. Commits on `main` follow Conventional Commits.
2. A release PR collects them into a changelog and bumps the version.
3. Merging it creates a git tag (`v0.3.0`), a GitHub Release and a Docker image.

Before `1.0.0`, anything can change. After `1.0.0`, breaking changes need a major version.

---

## 10. Community health

- Label easy tasks `good first issue`. New contributors look for that label.
- Reply to new issues within a few days, even if it's just "thanks, looking into it".
- Thank people. Merged first PRs turn users into contributors.
- Write decisions down (ADRs), so discussions don't repeat.
