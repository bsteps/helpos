# Quality gates

The `Lint, typecheck, test` CI job enforces coverage, bundle size and seeded API read latency. Playwright keeps a video of every failed test in the failure artifact.

## Coverage

`pnpm test:coverage` runs the Vitest suites once across all seven application and library workspaces. V8 coverage uses explicit production-source includes, so a file that no test imports still counts. Tests in `src` run through each workspace's configuration. The server keeps its contract setup and real Postgres global setup.

`@vitest/coverage-v8` is pinned to the exact version of the Vitest runner it reports for, because it requires that exact peer.

| Metric     | Required floor |
| ---------- | -------------: |
| Statements |            76% |
| Branches   |            64% |
| Functions  |            70% |
| Lines      |            77% |

The floors are regression floors just below the measured baseline, rounded down to whole percentages. ADR 0005 sets no percentage. The aggregate includes untested React screens and CLI entry points. Browser execution does not contribute to V8's Node coverage, so the report describes source test coverage, not coverage of every user flow. CI uploads the HTML and JSON summary for seven days.

| Exclusion                                  | Reason                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `**/*.test.{ts,tsx}`                       | Test assertions are not production behavior. This also matches integration test filenames. |
| `**/*.d.ts`                                | Type declarations have no executable behavior.                                             |
| Web `schema.gen.ts` and `routeTree.gen.ts` | Generated API types and router declarations.                                               |
| Server `src/testing/**`                    | Contract assertions and Vitest setup, not production request handling.                     |
| Server `src/**/testing.ts`                 | The AI-budget fixture helper.                                                              |
| Server `src/e2e/**`                        | Disposable composed browser-test server and fixtures.                                      |
| DB and AI `src/testing.ts`                 | Disposable database provisioning, leak fixtures and deterministic models.                  |

Never exclude a source folder because its coverage is low.

Server and DB unit and integration projects run each test file once. Both server projects load `apps/server/src/testing/setup.ts`; only integration projects start Postgres, and their files are named `*.int.test.ts`. `scripts/quality-gates.test.mjs` resolves the real Vitest projects, without running tests, to prove no file is selected twice and no project loses its setup.

## Bundles

The web build runs `apps/web/scripts/check-budget.mjs`. Its initial scripts and modulepreload chunks must total at most 200 × 1024 gzip bytes.

`pnpm check:widget` reserves `apps/widget` as the adoption hook. Once that directory exists, its build must produce `dist` with JavaScript or CSS. The checker sums each JavaScript and CSS file recursively, compressed separately at gzip level 9, and rejects totals over 20 × 1024 bytes. CI runs it after workspace builds, so a missing build or empty output fails on adoption. The widget must join the workspace build graph and use this location, or update the hook in its PR.

Until `apps/widget` exists the checker reports `absent`, which is not a measurement. Its tests use synthetic fixtures for small, missing, empty and oversized artifacts.

## API reads

`pnpm test:performance` starts disposable migrated `pgvector/pgvector:pg17` Postgres through the DB test helper. It writes the deterministic demo seed, starts the production composed API with the Node HTTP adapter, and sends real HTTP requests with the seed's scoped agent tokens. It does not load `.env`, start a worker, or call an AI or email provider.

The dataset has two tenants, 14 conversations, 22 messages and 11 drafts. Four workloads read each tenant's complete conversation list and one nonempty conversation detail. The script checks IDs, subjects and message text against the seed after each successful response. An unauthenticated preflight must return 401. There is no contract-validation wrapper in this process.

Each workload runs five rounds. Each round warms up with 20 reads and measures 100 sequential reads at concurrency one. Timing starts before `fetch` and ends after the complete response body arrives. Parsing and validation follow timing. The p95 is the sorted sample at `ceil(0.95 × 100)`, using one-based indexing. Every workload in every round must have p95 strictly below 100 ms, exactly 100 successful measured reads and zero errors. Warmup errors also fail. The gate never retries, discards slow samples or averages rounds to pass.

Raw samples, response bytes, errors, dataset, host, Node version and Git head go to `.helpos/read-budget.json`. CI uploads that file for seven days. The disposable helper disables durability, so this is a read regression gate on its seeded environment, not a measure of production capacity, cold starts, write durability, large datasets or concurrent load. Windows load averages are always zero; capture CPU utilization separately when comparing local runs.

## Failure videos

Playwright uses `video: "retain-on-failure"`, alongside retained traces and failure screenshots. Videos land under `apps/web/test-results/`. The `failure()` upload includes that directory and the HTML report, with seven-day retention.

## Rerun

Run these checks from the repository root with Docker available.

```sh
pnpm verify
pnpm test:scripts
pnpm test:coverage
pnpm check:widget
pnpm test:performance
pnpm test:e2e
```

`pnpm verify` runs the test and build checks. Coverage, widget adoption, the HTTP budget and Playwright run separately.
