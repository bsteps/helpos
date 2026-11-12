# Public HTTP contracts integration

## Scope and prerequisites

Finish the six selected HTTP and quality cleanup issues before features. Branch `333-public-http-contracts` targets `329-auditable-operations`. PR332 is an additional normal-merged prerequisite. The root finalizes the base after both prerequisites land. Neither prerequisite is counted among the six originals.

| Prerequisite | Exact head | Accounting |
| --- | --- | --- |
| [PR334](https://github.com/bsteps/helpos/pull/334) | `4cbbdc13e31a4de6a743a53378eb2b2e2946a192` | Published auditable operations head. Contains code pin `25d4de4c634f08a5ac97dda9d96b3a138a7320bd`; only evidence documentation follows it. |
| [PR332](https://github.com/bsteps/helpos/pull/332) | `76b245effcb4d048d553806370cf58fabacd2156` | Normal merge `0023c69771aafe4097e8ac3e8a81ef06184d6a31`. Preserves extracted panels, uncertainty choices, history, exhaustive maps and typed knowledge helpers. |

Both contain PR315. Their merge base is `80d10689dc1fe917c8f6364d5015edee9b7ad90e`. Shared ancestors are present once. Parent branches and PRs are unchanged. See [auditable operations](329-auditable-operations.md) and [conversation UI safety](327-conversation-ui-safety.md) for inherited source assignments and proof.

## Six frozen originals

| Issue and PR | Frozen head | Unique-delta parent | Merge base with PR334 | Inherited verdict |
| --- | --- | --- | --- | --- |
| #10, [PR305](https://github.com/bsteps/helpos/pull/305) | `6998b6e176a468e65cf12687b4ef4d3bc36034f4` | `c44af156505c9f018d175f8d1845ee0286aa5e23` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/305#issuecomment-6810891044) |
| #209, [PR261](https://github.com/bsteps/helpos/pull/261) | `2046da675f94e07e60070181caddca2499778da7` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/261#issuecomment-6805635069) |
| #233, [PR306](https://github.com/bsteps/helpos/pull/306) | `a5473725b7da1b43bd41523887578613aa8dc3a2` | `6998b6e176a468e65cf12687b4ef4d3bc36034f4` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/306#pullrequestreview-5867333228) |
| #211, [PR307](https://github.com/bsteps/helpos/pull/307) | `fd147826f8f2434b9e1ed6cb01cda09ad766481e` | `a5473725b7da1b43bd41523887578613aa8dc3a2` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/307#pullrequestreview-5867425200) |
| #210, [PR308](https://github.com/bsteps/helpos/pull/308) | `67d758cbb099d31449a07297605cb679ac5d7779` | `fd147826f8f2434b9e1ed6cb01cda09ad766481e` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/308#issuecomment-6811957959) |
| #22, [PR309](https://github.com/bsteps/helpos/pull/309) | `5577612b68a521c7b7125b415c258564bcba24f8` | `67d758cbb099d31449a07297605cb679ac5d7779` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/309#issuecomment-6812266546) |

Only the nine unique source commits below were cherry-picked. Each retains its original author and authored date with `-x` provenance. Old parent chains were not replayed.

| Original commit | Applied commit |
| --- | --- |
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
