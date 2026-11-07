# Architecture Decision Records (ADRs)

Each file records **one decision**: the context, what we chose, what we rejected, and the consequences. A decision is never changed after it's accepted (typo fixes are fine). To change a decision, write a new ADR that supersedes the old one.

| #                                                | Decision                                              | Status                                    |
| ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------- |
| [0001](0001-record-architecture-decisions.md)    | Record architecture decisions                         | Accepted                                  |
| [0002](0002-tech-stack.md)                       | Tech stack: one TypeScript/Node image + Postgres      | Accepted                                  |
| [0003](0003-tenant-isolation.md)                 | Tenant isolation with Postgres RLS and `withTenant()` | Accepted                                  |
| [0004](0004-security-baseline.md)                | Security baseline for an agent-first product          | Accepted                                  |
| [0005](0005-verification-over-manual-testing.md) | Automated verification replaces manual testing        | Accepted                                  |
| [0006](0006-performance-budgets.md)              | Performance budgets enforced in CI                    | Accepted                                  |
| [0007](0007-licensing-and-open-core.md)          | AGPL-3.0 + CLA, private cloud repo                    | Accepted (CLA tooling superseded by 0008) |
| [0008](0008-cla-assistant.md)                    | Collect CLA signatures with cla-assistant.io          | Accepted                                  |
| [0009](0009-tenant-isolation-extended.md)        | Tenant isolation for auth, jobs, realtime and vectors | Accepted                                  |
| [0010](0010-config-in-git.md)                    | Config, knowledge and policies in git                 | Accepted                                  |

For how the decisions fit together, see [the architecture overview](../architecture/overview.md).

New ADR: copy the newest file, increment the number, and open a PR.
