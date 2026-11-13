# 0006. Performance budgets enforced in CI

- Status: Accepted
- Date: 2026-11-06

## Context

Incumbent helpdesks are widely seen as slow. Speed is a feature we want to keep, and products get slower one PR at a time unless something stops it.

## Decision

CI will fail a PR that breaks a budget (enforcement lands with issue #22):

| Budget                              | Limit                                                 |
| ----------------------------------- | ----------------------------------------------------- |
| Chat widget bundle                  | ≤ 20 KB gzipped                                       |
| Dashboard initial JS                | ≤ 200 KB gzipped (to be tuned)                        |
| API latency (p95, seeded benchmark) | < 100 ms for reads                                    |
| AI reply                            | First token streamed in ~1 s (tracked; not a CI gate) |

Help center content is served through the API and MCP, so its reads use the API latency budget ([ADR 0012](0012-headless-help-center.md)). Teams measure the performance of the sites they render.

The dashboard uses optimistic updates, a client cache, live WebSocket updates and preloading. A local-first sync engine (Zero/ElectricSQL) is an option later.

## Consequences

Raising a budget needs an explicit PR that explains why.
