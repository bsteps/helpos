# Public HTTP contracts integration

## Scope and prerequisites

Finish the six selected HTTP and quality cleanup issues before features. Branch `333-public-http-contracts` targets `329-auditable-operations`. PR332 is an additional normal-merged prerequisite. The root finalizes the base after both prerequisites land. Neither prerequisite is counted among the six originals.

| Prerequisite                                       | Exact head                                 | Accounting                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PR334](https://github.com/bsteps/helpos/pull/334) | `4cbbdc13e31a4de6a743a53378eb2b2e2946a192` | Published auditable operations head. Contains code pin `25d4de4c634f08a5ac97dda9d96b3a138a7320bd`; only evidence documentation follows it.                      |
| [PR332](https://github.com/bsteps/helpos/pull/332) | `76b245effcb4d048d553806370cf58fabacd2156` | Normal merge `0023c69771aafe4097e8ac3e8a81ef06184d6a31`. Preserves extracted panels, uncertainty choices, history, exhaustive maps and typed knowledge helpers. |

Both contain PR315. Their merge base is `80d10689dc1fe917c8f6364d5015edee9b7ad90e`. Shared ancestors are present once. Parent branches and PRs are unchanged. See [auditable operations](329-auditable-operations.md) and [conversation UI safety](327-conversation-ui-safety.md) for inherited source assignments and proof.

## Six frozen originals

| Issue and PR                                             | Frozen head                                | Unique-delta parent                        | Merge base with PR334                      | Inherited verdict                                                                    |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| #10, [PR305](https://github.com/bsteps/helpos/pull/305)  | `6998b6e176a468e65cf12687b4ef4d3bc36034f4` | `c44af156505c9f018d175f8d1845ee0286aa5e23` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/305#issuecomment-6810891044)      |
| #209, [PR261](https://github.com/bsteps/helpos/pull/261) | `2046da675f94e07e60070181caddca2499778da7` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/261#issuecomment-6805635069)      |
| #233, [PR306](https://github.com/bsteps/helpos/pull/306) | `a5473725b7da1b43bd41523887578613aa8dc3a2` | `6998b6e176a468e65cf12687b4ef4d3bc36034f4` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/306#pullrequestreview-5867333228) |
| #211, [PR307](https://github.com/bsteps/helpos/pull/307) | `fd147826f8f2434b9e1ed6cb01cda09ad766481e` | `a5473725b7da1b43bd41523887578613aa8dc3a2` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/307#pullrequestreview-5867425200) |
| #210, [PR308](https://github.com/bsteps/helpos/pull/308) | `67d758cbb099d31449a07297605cb679ac5d7779` | `fd147826f8f2434b9e1ed6cb01cda09ad766481e` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/308#issuecomment-6811957959)      |
| #22, [PR309](https://github.com/bsteps/helpos/pull/309)  | `5577612b68a521c7b7125b415c258564bcba24f8` | `67d758cbb099d31449a07297605cb679ac5d7779` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/309#issuecomment-6812266546)      |

Only the nine unique source commits below were cherry-picked. Each retains its original author and authored date with `-x` provenance. Old parent chains were not replayed.

| Original commit                            | Applied commit                             |
| ------------------------------------------ | ------------------------------------------ |
| `bc07ca229de2ecee976180697ee6d2c8cbfa81bb` | `b457b1f94fbd7b7342ba40646d84ac0261ff65ec` |
| `f21a1599248f19396e6be06034e7db55f2b9be16` | `c6e26c62d1f485da4b66a31deae05b427d0abcc6` |
| `6998b6e176a468e65cf12687b4ef4d3bc36034f4` | `04f80d39c1f1402eeb3807d63ba33f662acc828c` |
| `2046da675f94e07e60070181caddca2499778da7` | `be4a038da1d035c9deba7ae486e27dc29db92da5` |
| `a5473725b7da1b43bd41523887578613aa8dc3a2` | `2805c815680ca508422d4edf5878872a826e996a` |
| `fd147826f8f2434b9e1ed6cb01cda09ad766481e` | `67a29a815b7c8b2f6435c2b57397d0f09297b798` |
| `84a2193f1a5114316ddefa6fe98da87a31f4bd94` | `66ec10694e2e3336d7422b12f7d6428dfc87f7f0` |
| `67d758cbb099d31449a07297605cb679ac5d7779` | `17d54310e868671e4d70d56ab74bc1e0b8b09e0c` |
| `5577612b68a521c7b7125b415c258564bcba24f8` | `0e8d40f0fd0a6a63232673f1c3cc5b837fc35aa1` |

The source #10 FAIL was corrected by its frozen current-request-ID replay fix. The source #210 FAIL was corrected by its frozen chained-reference, external-reference and invalid-spec fixes. Their prior failing evidence remains historical. Green advisory wrappers that say they did not finish are not completed reviews. Source reviews cover unchanged portions, not integration conflicts.

## Actual ports

- Regenerated OpenAPI and dashboard types from the combined routes. All 36 documented operations retain explicit unique semantic IDs. One server error-code list constrains the production response builder and generates the dashboard error-code type. The exhaustive common message map and contextual overrides use that type.
- Ported #233 into the actual extracted `lib/settings.ts` and `lib/knowledge-form.ts`. Draft error messages remain in `draft-view.ts`, used by `conversation-drafts.tsx`. Knowledge domain operations, regenerate ownership, close/message-write ownership, typed AuditContext/Actor and auth policy remain inherited. No handler business logic was restored.
- Generated `0025_http-idempotency.sql` and its snapshot against the actual schema after 0024. The generated SQL retains the source FORCE RLS and DELETE/TRUNCATE revocations. Snapshots and SQL for 0022, 0023 and 0024 remain byte-identical. Journal entries through 0024 remain unchanged. A second generation writes nothing. The new snapshot differs from 0024 only in IDs and the new table.
- Preserved auth-before-replay, credential and noCaller keyed refusals, caller/tenant/scopes/body fingerprinting, durable pending and expired tombstones, and current request IDs on successful 201 and empty 204 replays. Successful responses replay for 24 hours. Accessed expired bodies are cleared; no automatic tombstone or unaccessed-body purge is claimed. Approval replay does not confirm delivery.
- Kept #209 CSP, cache, framing, referrer and SPA fallback behavior, including missing-asset HTML fallback. Its test moves to `dashboard.int.test.ts` and uses the actual app outside the JSON contract wrapper because static hosting is not an OpenAPI operation. All 12 assertions remain, with conversation paths and current health/problem-media expectations.
- Moved the DB-backed pagination fixture to `pagination.int.test.ts`. The existing filename guard rejects either old unit name. Vitest discovery proves both files select only the integration project. No assertion was removed.
- Kept #241 unit/integration isolation and #200 waits. Coverage projects flatten the actual server/DB unit and integration selections, keep response-contract setup in both server projects, and initialize Postgres only in integration projects. A nonexecuting project-selection test prevents duplicate selection or lost setup. Production/UI includes and the original floors remain unchanged.
- Ported the OpenAPI assertion to the actual typed knowledge `state` contract instead of the removed flat ingestion `error`. Local response-reference chains, cycle checks, remote-reference rejection and spec validation before intended-break handling remain from #210.

The actual PR334-base compatibility comparison returns an empty breaking report without an exception. The specific source #210 justification corrects knowledge.createSource, knowledge.updateSource and knowledge.reingestSource success declarations to application/json and removes impossible problem fields. It describes those source declarations only. It is not blanket break permission or human approval.

## Verification and limits

All seven package typechecks passed fresh initially. Candidate checks passed with three executed and four valid cache hits. The corrected API unit selection passes 274 tests across seven files, including two DB pagination assertions later reclassified as integration tests. All seven web unit files pass 135 tests. The initial 66 tooling checks passed 65 and failed the filename guard on pagination; after both renames the six selection/filename/gate checks pass. Compatibility tests use the real pinned tool and local loopback fixtures. No broad test:scripts command or TLC selftest was run.

The first API selection accidentally started two finite owned PG fixtures from the stale dashboard and pagination unit names. A second selection before the filename-guard result arrived started the pagination fixture once more. These three ungranted fixtures are a resource-scheduling error. Both runner processes exited, their afterAll hooks awaited database close and owned container stop, and no detached application runtime was started. The corrected filenames and guard prevent recurrence. No shared Docker stop, removal or settings change was performed.

Source latency evidence is reused for unchanged read handlers and HTTP timing protocol. It measures sequential seeded local reads with warm pools, complete-body timing and checked content. It is not throughput, production capacity, cold-start or a global performance claim. No optional performance campaign was run. Combined coverage and the one stable plain EVAL_LIVE=0 pnpm verify need separate root resource grants; plain verify does not invoke coverage.

The accepted #22 criterion keeps the 20 KB widget adoption gate and defers actual-widget measurement until an artifact exists. [The acceptance receipt](https://github.com/bsteps/helpos/pull/309#issuecomment-6815642048) does not authorize a merge. The frozen [CI run](https://github.com/bsteps/helpos/actions/runs/43136815949) has only the quality-gate-evidence artifact and no failure-video artifact. Local VP9 recording and upload wiring are inherited evidence. Hosted failure-video upload remains unobserved. No artificial failing hosted run was created.

Deslop completed. The one native same-model gpt-6.1-sol xhigh Comment Sicko identified one misplaced private form comment, which was deleted. Public API contract comments remain. No suppressions, further helpers or review fleet were added. Model the Domain shaped typed error-code maps; Laziness Protocol kept ports in existing extracted helpers; Prove It Works shaped actual codegen, migration and project-selection checks.

Evidence is in this checkout under `.helpos/333/`, including accounting, selection, typecheck, unit, tooling, compatibility and hosted-artifact receipts. The committed trail is [333-integration.tsv](../../333-integration.tsv). Fresh independent integration review remains root-owned. No live/billable providers ran. #205 and the known lost-retry/failed-give-up send stalls remain open. Offline checks do not prove live model quality or injection resistance.

## Focused PG phase

At committed `d3dccd014decca207c3fd1155a9d69898139ab94`, the root-granted focused run passed 190 tests in ten files. It selected composed HTTP, idempotency, pagination, dashboard, sessions, tokens and knowledge plus database schema, migrations and tenant-leak tests. Both projects used maxWorkers=1 against one separate PG container, inspected at 536870912 memory bytes and 1000000000 NanoCpus. The container ID was `405102d204c52e8eea1e8bd7919207f7d3a73ae2f2761c1b1143cbea5954661e`, on port 35459.

The runner exited 0 and awaited container stop. Its receipt confirms the PG container is gone and both checkout and main `.env` hashes are unchanged. No shared container was changed. The normal transient Testcontainers reaper also exited after the runner process ended, confirmed by an empty exact-ID running-container query. The test log and resource receipt are `.helpos/333/focused-pg.log` and `focused-pg-receipt.json`. The static covered-function fingerprint check reports no drift and did not invoke TLC or regenerate correspondence.

## Stable combined coverage

The single root-granted combined coverage campaign ran at exact `81004b848e40e79496cf4d6c59f2364b985a1685`, with code unchanged from `d3dccd0`. It passed all 1,475 tests in 101 files with maxWorkers=1 and fileParallelism=false. No coverage correction or repeat campaign was needed.

| Metric     | Actual numerator and denominator | Measured | Unchanged floor |
| ---------- | -------------------------------- | -------- | --------------- |
| Statements | 3690 / 4628                      | 79.73%   | 76%             |
| Branches   | 2286 / 3301                      | 69.25%   | 64%             |
| Functions  | 810 / 1095                       | 73.97%   | 70%             |
| Lines      | 3247 / 4046                      | 80.25%   | 77%             |

The report includes 150 production files, including 35 dashboard files and 25 dashboard files with zero line coverage. Untested UI remains in the denominator. Generated types and the documented test helpers remain excluded. This measures Node source execution, not browser flow coverage. The selection retains the landed #241 and #200 changes and both server response-contract setups.

The campaign captured seven owned PG containers, three short owned Mailpit containers and one Testcontainers reaper over the run. This includes the existing migration tests that start separate PG fixtures. All PG/Mailpit fixtures stopped before the runner exited 0. The reaper also exited, confirmed with an empty exact-ID running-container query after process exit. Both `.env` hashes are unchanged. Shared containers were untouched. No browser, live provider, TLC, performance or mutation campaign ran. Evidence includes `.helpos/333/coverage.log`, `coverage-receipt.json`, `coverage-denominator.json`, and the standard `coverage/coverage-summary.json` and HTML report. The final plain full gate remains separately scheduled.

## Final plain verification

The one root-granted `EVAL_LIVE=0 pnpm verify` passed at clean committed `1f985e3d396f3afae7c0fe95bf4b8840105690c5`, with no force flag. All 15 Turbo tasks succeeded, nine freshly executed and six valid cache hits. Every package test task was a cache MISS. Fresh counts were 1,037 server tests across 68 files, 110 DB tests across 14 files, 135 web tests across seven files, and 193 other package tests across 12 files, for the same total of 1,475 tests. The web typecheck and build also executed fresh; the other six typechecks reused valid cache entries.

Biome, Knip, the dashboard build and its existing 200 KB budget, all 29 offline eval cases, and the locked-shadow demo configuration check passed. Only the two existing undeclared-environment-variable warnings and existing Vite chunk advisory remain. These offline eval results are not live-quality or injection-resistance proof.

The command and runner exited 0. Head and tracked status remained unchanged throughout. All owned PG and Mailpit containers stopped; the transient reaper also exited after the runner, confirmed by an empty exact-ID running-container query. Both checkout and main `.env` hashes are unchanged, and no shared Docker resource was modified. Evidence is `.helpos/333/verify.log` and `verify-receipt.json`. No code, type or schema fix followed the verified code. The following commit adds this evidence only. Fresh independent integration review remains root-owned, and `pr:in-progress`, `needs-human` and `security` remain required.

## Independent review fixes

An independent review of `0023c69..17625d9` against base `4cbbdc13e31a4de6a743a53378eb2b2e2946a192` found five actionable problems. Each fix has a test that fails without it.

- Write routes chose replay or refusal through a hand-kept list of three credential paths, so a new route returning a secret would have stored it for replay. `apiRoute()` now requires `idempotency: "replay" | { refuse }` on every write, `noCaller` routes can only refuse, only replay routes document `Idempotency-Key` and the idempotency 409/503, and `x-idempotency` is published. Runtime behavior of existing routes is unchanged.
- The contract gate failed on every oasdiff finding, so adding one error code (162 `response-property-enum-value-added` warnings) required an `API-Break:` line. Additive response enum values are now reported but pass. Removed and retyped fields still fail. An empty PR body is no longer read from the event file path.
- `/health` became liveness only, but the demo healthcheck and the CI `pnpm dev` smoke test still used it as a database check. Both use `/readyz`.
- An unreadable 5xx body became `bad_request`; it is now `internal_error`.
- `docs/quality-gates.md` and `docs/api-conventions.md` carried measurement history and issue references, and AGENTS.md said `pnpm verify` runs everything CI runs. They now state rules and reasons only, and AGENTS.md lists the new enforced rules.

Reported at that review: stored replay bodies have no retention job (the table revokes DELETE); only request-completion, unhandled-error and readiness logs carried the request ID; no list route uses the pagination helper yet. `/security-review` on that fixed head found no high-confidence vulnerability. The request-log gap is addressed below.

The hosted failure-video gap is closed. Probe [PR340](https://github.com/bsteps/helpos/pull/340) (closed, never merged) ran this branch's unchanged Playwright config and upload step on `17625d9` with one deliberately failing test. [Run 43214261280](https://github.com/bsteps/helpos/actions/runs/43214261280) uploaded `playwright-traces` containing `test-results/…/video.webm` (25,667 bytes, valid WebM header), its screenshot and trace. The review fixes do not touch the Playwright config or the upload step.

## Request-log correlation

The user requested request IDs throughout request handling. The shared logger now inherits the active HTTP request ID through `AsyncLocalStorage`, including nested services and child loggers. The active ID takes precedence over a stale ID in a log entry. Middleware starts the context after incoming ID validation and keeps response handling and error logs inside it. Concurrent requests have separate contexts, and unrelated startup and background logs receive no invented HTTP identity.

Four regression tests cover interleaved requests, generated IDs and context restoration after an exception, an existing inbound-email warning, and child logger redaction with a stale ID. The first two failed before the source fix. All 28 focused logger/HTTP tests and 569 server unit tests pass. Workspace typechecks, Biome and Knip pass. No database schema, queue payload, replay retention, public response or authorization behavior changes.

The follow-up starts at `1eef3830605ab360fbb16bf758afc22dedc939c7`. The PR now targets `main`, observed at `9890b531627d68bbfb7110ca7090fbfcef6f8f7c`, with merge base `58451595845f67aef0fb35e0ba584bac71ad1045`. This change does not refresh parent branches or assume that their squash-merged history has been reconciled.

A fresh `claude-work` Opus 5.5 high recheck was attempted for this change, including the actual `/security-review` and comments review. It failed before executing with `Claude API rate limit reached. Try again later.` The prior clear reviews cover `1eef383`, not this follow-up. Fresh independent code/security review is blocked, and hosted CI for the new commit remains pending. No merge is authorized.
