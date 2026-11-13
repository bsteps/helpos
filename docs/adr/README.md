# Architecture Decision Records (ADRs)

Each file states one current decision, its reason and its consequences. When an approved decision changes, update the ADR and its references directly. Remove obsolete wording and redundant records so agents and contributors have one decision to follow. Git keeps the history.

| #                                                | Decision                                              | Status   |
| ------------------------------------------------ | ----------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)    | Record architecture decisions                         | Accepted |
| [0002](0002-tech-stack.md)                       | Tech stack: one TypeScript/Node image + Postgres      | Accepted |
| [0003](0003-tenant-isolation.md)                 | Tenant isolation with Postgres RLS and `withTenant()` | Accepted |
| [0004](0004-security-baseline.md)                | Security baseline for an agent-first product          | Accepted |
| [0005](0005-verification-over-manual-testing.md) | Automated verification replaces manual testing        | Accepted |
| [0006](0006-performance-budgets.md)              | Performance budgets enforced in CI                    | Accepted |
| [0007](0007-licensing-and-open-core.md)          | AGPL-3.0 + CLA, private cloud repo                    | Accepted |
| [0008](0008-cla-assistant.md)                    | Collect CLA signatures with cla-assistant.io          | Accepted |
| [0009](0009-tenant-isolation-extended.md)        | Tenant isolation for auth, jobs, realtime and vectors | Accepted |
| [0010](0010-config-in-git.md)                    | Rules, knowledge and settings in git                  | Accepted |
| [0011](0011-the-gate.md)                         | One gate for every agent, trust earned from outcomes  | Accepted |
| [0012](0012-headless-help-center.md)             | A headless help center                                | Accepted |

For how the decisions fit together, see [the architecture overview](../architecture/overview.md).

For a new decision, copy the newest file, increment the number, and open a PR. `scripts/adr-current.test.mjs` checks the index, current ADR references and the absence of historical addenda.
