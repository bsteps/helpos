# Check: security baseline

What the security-baseline check looks for in a diff. Follow it when you write code too. The reasons are in [ADR 0004](../adr/0004-security-baseline.md) and the [trust boundaries](../architecture/overview.md#trust-boundaries).

## Flag

1. **A route or action with the wrong scopes.** Every route declares `access` in `apiRoute()`, and tests already fail a route without one. Judge whether the scopes are the narrowest that fit (read vs write), and whether the response shows data that needs another scope: that data needs a `Grant` (see `apps/server/src/auth/access.ts`). Flag an `anyCaller` or `noCaller` whose reason doesn't hold.
2. **A write without an audit event.** Every human or agent action calls `recordAudit(tx, …)` in the same transaction as the change: who, what, why, and the inputs. Write routes declare `audit` in `apiRoute()`, and a success that records nothing fails, so judge what the checks can't: a `none` whose reason doesn't hold, a `nothingToAudit()` on a path that did change something, and actions outside routes (workers, CLI) that record nothing.
3. **An action that skips the policy or approval path.** Agent writes are off by default; nothing reaches a customer without approval. Flag new paths that send, refund, or change accounts directly.
4. **A private endpoint.** A dashboard feature that calls an endpoint not in the OpenAPI spec.
5. **Inbound content used as instructions.** Email, chat, imported pages or knowledge passages joined into the model's instructions instead of quoted as data, or AI output that triggers an action without the policy path.
6. **Unsafe output.** Customer HTML or AI output rendered without sanitising, outside the sandboxed iframe, or with remote images or links that skip the allowlist.
7. **Fetching a URL someone else chose** without `packages/safe-fetch`.
8. **Secrets.** Logged, returned by the API, stored unencrypted, hardcoded, or tokens stored unhashed.
9. **Weaker auth.** A cookie-authenticated write without the `Origin` check, a token that can create tokens or hold `workspace:admin`, a webhook without signature and replay checks.
10. **Weaker CI.** In `.github/workflows`, `.claude`, `AGENTS.md` or `CLAUDE.md`: `pull_request_target`, `workflow_run` with secrets, an action not pinned to a commit SHA, broader `permissions:`, `persist-credentials` not `false`, PR or issue text put inside a `run:` script through `${{ }}`, or AI review settings loosened (more tools, more turns, `allowed_non_write_users`, `allowed_bots`, a shell for review jobs).
11. **New suppressions in security code.** A `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, `any`, non-null `!` or `console.*` in auth, tokens, policy, tenant or secrets code. Changes like these always need a human.
12. **A new way in or a new agent capability without a threat-model update.** A new channel, import or connector, a new action type, scope or tool, or a new outside connection that holds a secret, in a PR that leaves [the threat model](../security/threat-model.md) unchanged.

## Don't flag

- The known shortcuts in the [shortcuts before the first real reply](../architecture/overview.md#shortcuts-before-the-first-real-reply) table. They're tracked.
- Tenant isolation (its own check), test quality (its own check), style and naming.
