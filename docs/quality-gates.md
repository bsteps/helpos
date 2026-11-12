# Quality gates

The existing `Lint, typecheck, test` CI job enforces coverage, bundle size and seeded API read latency. Playwright retains videos of failed tests in the existing failure artifact. These checks implement the available parts of #22 without changing product behavior.

## Coverage

`pnpm test:coverage` runs the existing Vitest suites once across all seven application and library workspaces. V8 coverage uses explicit production-source includes, including files that no test imports. Tests in `src` still run through each workspace's configuration. The server keeps its contract setup and real Postgres global setup.

The new development dependency `@vitest/coverage-v8` is pinned to 5.1.0, matching its exact Vitest peer requirement and the existing runner. The npm registry records its release on November 2, 2026, before the repository's three-day minimum age. It is maintained in the [Vitest repository](https://github.com/vitest-dev/vitest/tree/main/packages/coverage-v8) under the [MIT license](https://github.com/vitest-dev/vitest/blob/main/LICENSE), compatible with this project's AGPL distribution. The provider supplies V8 remapping and threshold enforcement instead of a custom coverage engine. Configuration follows upstream [coverage](https://vitest.dev/guide/coverage.html) and [test projects](https://vitest.dev/guide/projects.html) documentation. `pnpm peers check` reports only the existing openapi-typescript TypeScript 6 mismatch.

The first measurement on the frozen source parent `84a2193f1a5114316ddefa6fe98da87a31f4bd94`, with the coverage configuration added, passed 1,191 tests in 88 files.

| Metric     | Measured source coverage | Required floor |
| ---------- | -----------------------: | -------------: |
| Statements |                   76.77% |            76% |
| Branches   |                   64.21% |            64% |
| Functions  |                   70.58% |            70% |
| Lines      |                   77.34% |            77% |

These are regression floors below the measured baseline, rounded down to whole percentages. ADR 0005 does not specify a percentage. The aggregate includes untested React screens and CLI entry points. Browser execution does not contribute to V8's Node coverage. The report therefore describes source test coverage, not coverage of every user flow. CI uploads the HTML and JSON summary for seven days.

The exclusions have these purposes.

| Exclusion                                  | Reason                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `**/*.test.{ts,tsx}`                       | Test assertions are not production behavior. This also matches integration test filenames. |
| `**/*.d.ts`                                | Type declarations have no executable behavior.                                             |
| Web `schema.gen.ts` and `routeTree.gen.ts` | Generated API types and router declarations.                                               |
| Server `src/testing/**`                    | Contract assertions and Vitest setup, not production request handling.                     |
| Server `src/**/testing.ts`                 | The AI-budget fixture helper.                                                              |
| Server `src/e2e/**`                        | Disposable composed browser-test server and fixtures.                                      |
| DB and AI `src/testing.ts`                 | Disposable database provisioning, leak fixtures and deterministic models.                  |

No source folder is excluded because its coverage is low. An unimported temporary production file with 500 functions makes the coverage gate fail and is then removed in the negative proof.

The combined configuration includes the landed #241 test split and #200 worker waits. Server and DB unit and integration projects run each test file once. Both server projects retain `apps/server/src/testing/setup.ts`; only integration projects initialize Postgres. `app.int.test.ts`, `knowledge/knowledge.int.test.ts`, `web/dashboard.int.test.ts` and `http/pagination.int.test.ts` are integration tests. `testing/contract.test.ts` remains a unit test. The selection test resolves the real Vitest projects without executing tests. Source percentages above are historical. The combined #333 campaign passes 1,475 tests in 101 files. It measures statements 79.73%, branches 69.25%, functions 73.97% and lines 80.25%, with unchanged floors. Its 150 production files include 35 dashboard files, 25 with zero line coverage. See [the integration evidence](integrations/333-public-http-contracts.md).

## Bundles

The existing web build still runs `apps/web/scripts/check-budget.mjs`. Its initial scripts and modulepreload chunks must total at most 200 × 1024 gzip bytes. The measured source build is 183.0 KB. Tests prove that a preload chunk over budget fails. A temporary enlargement of the actual build output also fails, after which the original bytes are restored.

`pnpm check:widget` reserves `apps/widget` as the adoption hook. Once that directory exists, its build must produce `dist` with JavaScript or CSS. The checker sums each JavaScript and CSS file recursively, compressed separately at gzip level 9, and rejects totals over 20 × 1024 bytes. CI runs it after workspace builds, so a missing build or empty output fails on adoption. The widget implementation must join the workspace build graph and use this location, or explicitly update the hook in its PR.

There is no widget workspace or bundle in this source baseline. The checker reports `absent`, not a successful bundle measurement. Synthetic fixtures prove small, missing, empty and oversized artifact behavior only. The accepted criterion keeps the 20 KB adoption gate and defers actual-widget measurement until a widget artifact exists. The roadmap schedules the widget later. Synthetic fixtures do not measure that future artifact.

## API reads

`pnpm test:performance` starts disposable migrated `pgvector/pgvector:pg17` Postgres through the existing DB test helper. It writes the existing deterministic #24 seed, starts the production composed API with the Node HTTP adapter, and sends real HTTP requests with the seed's scoped agent tokens. It does not load `.env`, start a worker, or call an AI or email provider.

The dataset has two tenants, 14 conversations, 22 messages and 11 drafts. Four workloads read each tenant's complete conversation list and one nonempty conversation detail. The script checks IDs, subjects and message text against the seed after each successful response. An unauthenticated preflight must return 401. There is no contract-validation wrapper in this process.

Each workload runs five rounds. Each round warms up with 20 reads and measures 100 sequential reads at concurrency one. Timing starts before `fetch` and ends after the complete response body arrives. Parsing and validation follow timing. The p95 is the sorted sample at `ceil(0.95 × 100)`, using one-based indexing. Every workload in every round must have p95 strictly below 100 ms, exactly 100 successful measured reads and zero errors. Warmup errors also fail. The gate never retries, discards slow samples or averages rounds to pass.

Raw samples, response bytes, errors, dataset, host, Node version and Git head go to `.helpos/read-budget.json`. CI uploads that file for seven days. The local baseline used Node 24.14.0 on Windows with Docker Desktop, an Intel Core Ultra 7 265K and 20 logical CPUs. The disposable helper disables durability; this measures the read regression gate on its seeded environment, not production capacity, cold starts, write durability, large datasets or concurrent load. A separate profiled run is excluded from reported latency. It spends most samples idle, with socket writes and Postgres protocol work among active samples. The sequential request path waits on local HTTP and database round trips rather than saturating the generator. Startup is included in that profile, so it is not a precise request-only breakdown. Windows load averages are always zero; capture CPU utilization separately when comparing local runs.

The restored negative proof inserts an awaited 110 ms delay inside the actual production list handler. Successful nonempty reads still run. The unchanged 100 ms gate rejects that run. The handler is restored byte for byte. This is an absolute budget check; no speedup is claimed.

## Failure videos

Playwright uses `video: "retain-on-failure"`, alongside retained traces and failure screenshots. Its default video attachment is under `apps/web/test-results/`. The existing `failure()` upload includes that directory and the HTML report, with seven-day retention. Action pins, permissions, the artifact name and zero retries stay intact.

A temporary failing browser test loads the real dashboard sign-in form, checks both input labels, then deliberately fails. It produces a nonempty WebM, screenshot, trace and HTML report. The probe is removed. This proves local recording and the upload-path wiring, not a hosted artifact upload. Hosted failure-video evidence remains unobserved unless an existing failed CI run supplies it; no deliberate failing CI cycle is required.

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

`pnpm verify` preserves the existing test and build checks. Coverage, widget adoption, the HTTP budget and Playwright run separately. Run the final gate on stable committed code with valid Turbo cache entries, and report executed tasks and cache hits separately. The parent API compatibility job is unchanged. Its three-operation knowledge declaration justification belongs only to #210 and does not waive future contract breaks or approve a merge. Known send findings remain unchanged.
