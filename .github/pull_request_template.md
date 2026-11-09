## What does this PR do?

<!-- One or two sentences. Link the issue it closes: "Closes #123" -->

## Why?

<!-- The problem this solves. -->

## How was it tested?

<!-- Commands you ran, screenshots for UI changes. -->

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:` …)
- [ ] Tests added or updated (or explained why not)
- [ ] No secrets, personal data or customer data in code, tests or logs
- [ ] Touches tenant data? It goes through `withTenant()`, and a cross-tenant test covers it
- [ ] New agent or API action? It's scoped by token permissions, checked by the policy layer, and written to the audit log
- [ ] Labelled `security` or `area:db`? I ran `/security-review` locally and fixed or answered every finding
- [ ] State label set: `needs-human` if this touches security, auth, tenant isolation or product defaults, or adds a lint/type suppression; otherwise `pr:ready` (see "Label states" in AGENTS.md)
- [ ] Docs updated if behaviour changed
