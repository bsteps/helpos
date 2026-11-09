# Check: security baseline

What the security-baseline check looks for in a diff. Follow it when you write code too. The reasons are in [ADR 0004](../adr/0004-security-baseline.md) and the [trust boundaries](../architecture/overview.md#trust-boundaries).

## Flag

1. **A route or action without a scope check.** Every new endpoint or agent action checks the principal's scopes (`principal.scopes.has(…)`) before it touches data, with the narrowest scope that fits (read vs write).
2. **A write without an audit event.** Every human or agent action calls `recordAudit(tx, …)` in the same transaction as the change: who, what, why, and the inputs.
3. **An action that skips the policy or approval path.** Agent writes are off by default; nothing reaches a customer without approval. Flag new paths that send, refund, or change accounts directly.
4. **A private endpoint.** A dashboard feature that calls an endpoint not in the OpenAPI spec.
5. **Inbound content used as instructions.** Email, chat, imported pages, knowledge passages or GitHub text joined into the model's instructions instead of quoted as data, or AI output that triggers an action without the policy path.
6. **Unsafe output.** Customer HTML or AI output rendered without sanitising, outside the sandboxed iframe, or with remote images or links that skip the allowlist.
7. **Fetching a URL someone else chose** without `packages/safe-fetch`.
8. **Secrets.** Logged, returned by the API, stored unencrypted, hardcoded, or tokens stored unhashed.
9. **Weaker auth.** A cookie-authenticated write without the `Origin` check, a token that can create tokens or hold `workspace:admin`, a webhook without signature and replay checks.
10. **Weaker CI.** In `.github/workflows`, `.claude`, `AGENTS.md` or `CLAUDE.md`: `pull_request_target`, `workflow_run` with secrets, an action not pinned to a commit SHA, broader `permissions:`, `persist-credentials` not `false`, PR or issue text put inside a `run:` script through `${{ }}`, or AI review settings loosened (more tools, more turns, `allowed_non_write_users`, `allowed_bots`, a shell for review jobs).
11. **New suppressions in security code.** A `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, `any`, non-null `!` or `console.*` in auth, tokens, policy, tenant or secrets code. Changes like these always need a human.

## Don't flag

- The known MVP shortcuts in the [MVP vs first release](../architecture/overview.md#mvp-vs-first-release) table. They're tracked.
- Tenant isolation (its own check), test quality (its own check), style and naming.
