# Review checks

Short rule lists for the narrow AI review checks that run on pull requests. **Author agents follow the same lists before they open a PR**, so the writer and the reviewer work from one source.

| Check             | Rules                                        | Skill                                    | Runs when a PR changes                   |
| ----------------- | -------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Tenant isolation  | [tenant-isolation.md](tenant-isolation.md)   | `.claude/skills/tenant-isolation-check`  | `packages/db`, `apps/server/src`         |
| Security baseline | [security-baseline.md](security-baseline.md) | `.claude/skills/security-baseline-check` | server, web and package code, CI, deploy |
| Test signal       | [test-signal.md](test-signal.md)             | `.claude/skills/test-signal-check`       | tests, e2e, evals, fixtures              |

The lists say what to look for in a diff. The reasons live in the ADRs they link to; change those first, then the list.

## How the checks run

- One workflow per check (`.github/workflows/ai-check-*.yml`), started by `pull_request` on maintainers' branches in this repo. Fork PRs aren't reviewed (they get no secrets). Draft PRs and docs-only PRs are skipped.
- The reviewer is Claude Sonnet; our coding threads use Opus, so a model never reviews its own work.
- It posts inline comments only, and one status comment per check that says "All clear" or how many findings it left. It never approves or requests changes. **Results are advisory**: they never fail the PR.
- Cost caps per run: 15 turns, 10 minutes, Sonnet. Per PR: a new push cancels the running check.
- The skill and its rules are read from the **base branch**, so a PR can't change the rules it's checked against. A PR that changes a list is checked against the old one.
- `@claude` in an issue or PR comment (maintainers only) asks Claude for help on demand, including a full review.

Run a check locally before you open a PR: ask your agent to use the skill (for example `/tenant-isolation-check`) on your branch.
