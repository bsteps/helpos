# 0005. Automated verification replaces manual testing

- Status: Accepted
- Date: 2026-11-06

## Context

With coding agents, writing code is fast. The bottleneck is a human manually checking that it works. We want maintainers to **review evidence, not click around**.

## Decision

No PR merges without automated proof. A feature is "done" only when it ships with:

| Layer                                                                    | Tool                                                                           | Catches                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Unit + integration tests against **real Postgres** (throwaway container) | Vitest + Testcontainers                                                        | Logic, SQL, RLS                                        |
| Cross-tenant leak suite                                                  | Vitest                                                                         | Data leaks (ADR 0003)                                  |
| API contract tests generated from OpenAPI                                | Vitest                                                                         | Breaking agents' API                                   |
| End-to-end flows in a real browser                                       | Playwright                                                                     | Widget → AI → handoff → reply                          |
| Visual snapshots                                                         | Playwright                                                                     | UI regressions                                         |
| Email fixture corpus (real, messy emails)                                | Vitest                                                                         | Threading/parsing bugs. Every email bug adds a fixture |
| AI evals (golden tickets, citation faithfulness, injection fixtures)     | Eval runner from "test mode"                                                   | AI quality regressions                                 |
| Agent QA                                                                 | Coding agent drives the app in a browser and posts screenshots/video on the PR | "Does it actually work?"                               |

A seed script provides realistic demo data in one command, for tests, agent QA and local development.

## Consequences

- More test code than feature code in places. That's intended.
- Flaky tests are bugs: fix them or delete them, never retry blindly.
