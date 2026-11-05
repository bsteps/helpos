# Architecture Decision Records (ADRs)

Each file records **one decision**: the context, what we chose, what we rejected, and the consequences. ADRs are never edited after they're accepted. To change a decision, write a new ADR that supersedes the old one.

| #                                                | Decision                                              | Status   |
| ------------------------------------------------ | ----------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md)    | Record architecture decisions                         | Accepted |
| [0002](0002-tech-stack.md)                       | Tech stack: one TypeScript/Node image + Postgres      | Accepted |
| [0003](0003-tenant-isolation.md)                 | Tenant isolation with Postgres RLS and `withTenant()` | Accepted |
| [0004](0004-security-baseline.md)                | Security baseline for an agent-first product          | Accepted |
| [0005](0005-verification-over-manual-testing.md) | Automated verification replaces manual testing        | Accepted |
| [0006](0006-performance-budgets.md)              | Performance budgets enforced in CI                    | Accepted |
| [0007](0007-licensing-and-open-core.md)          | AGPL-3.0 + CLA, private cloud repo                    | Accepted |

New ADR: copy the newest file, increment the number, and open a PR.
