# Architecture Decision Records (ADRs)

Each file records **one decision**: the context, what we chose, what we rejected, and the consequences. A decision is never changed after it's accepted. To change a decision, write a new ADR that supersedes the old one, and link the old ADR to it with a `Superseded in part by` line under its status and a short note on each part it replaces. Edits that leave the decision as it was are fine, such as a typo, a renamed term or a link.

| #                                                | Decision                                                        | Status                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [0001](0001-record-architecture-decisions.md)    | Record architecture decisions                                   | Accepted                                                                 |
| [0002](0002-tech-stack.md)                       | Tech stack: one TypeScript/Node image + Postgres                | Accepted (help center superseded by 0012)                                |
| [0003](0003-tenant-isolation.md)                 | Tenant isolation with Postgres RLS and `withTenant()`           | Accepted                                                                 |
| [0004](0004-security-baseline.md)                | Security baseline for an agent-first product                    | Accepted (approval thresholds superseded by 0011)                        |
| [0005](0005-verification-over-manual-testing.md) | Automated verification replaces manual testing                  | Accepted                                                                 |
| [0006](0006-performance-budgets.md)              | Performance budgets enforced in CI                              | Accepted (help center superseded by 0012)                                |
| [0007](0007-licensing-and-open-core.md)          | AGPL-3.0 + CLA, private cloud repo                              | Accepted (CLA tooling superseded by 0008)                                |
| [0008](0008-cla-assistant.md)                    | Collect CLA signatures with cla-assistant.io                    | Accepted                                                                 |
| [0009](0009-tenant-isolation-extended.md)        | Tenant isolation for auth, jobs, realtime and vectors           | Accepted                                                                 |
| [0010](0010-config-in-git.md)                    | Config, knowledge and policies in git                           | Accepted (kinds, UI edits, policy wording and timing superseded by 0013) |
| [0011](0011-the-gate.md)                         | The gate: one check for every agent, trust earned from outcomes | Accepted                                                                 |
| [0012](0012-headless-help-center.md)             | A headless help center                                          | Accepted                                                                 |
| [0013](0013-rules-knowledge-settings-in-git.md)  | Rules, knowledge and settings in git                            | Accepted                                                                 |

For how the decisions fit together, see [the architecture overview](../architecture/overview.md).

New ADR: copy the newest file, increment the number, and open a PR.
