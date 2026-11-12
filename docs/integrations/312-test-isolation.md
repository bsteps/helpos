# Test isolation and reliable worker waits

This integration finishes the existing cleanup chain for #198, #241, and #200 before feature work. Contributors get a unit project without database setup and an integration project that waits for observable worker settlement. It adds no product feature.

## Base and frozen sources

The branch `312-test-isolation` starts at actual `origin/main`, `8af8f1f3f598b2d4ecfb4a1dcae0222b45f52551`. That main commit already contains [PR310](https://github.com/bsteps/helpos/pull/310). Its sources are not replayed. The selected chain shares base `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` with main.

| Source                                                   | Exact head                                 | Exact source base                          | Inherited independent verdict                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [PR276, #198](https://github.com/bsteps/helpos/pull/276) | `0ae82176a18d595c94179cd2d4f3b25609cd2f30` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | [PASS with notes](https://github.com/bsteps/helpos/pull/276#issuecomment-6806620276)                                                 |
| [PR296, #241](https://github.com/bsteps/helpos/pull/296) | `a40db3e59e2faba2138e0f33da291f777cf33f7b` | `0ae82176a18d595c94179cd2d4f3b25609cd2f30` | [Final PASS with notes, superseding the earlier evidence failure](https://github.com/bsteps/helpos/pull/296#issuecomment-6809355933) |
| [PR297, #200](https://github.com/bsteps/helpos/pull/297) | `5b0a05957b2d547781718cc0abf520d548fd61ae` | `a40db3e59e2faba2138e0f33da291f777cf33f7b` | [PASS with notes](https://github.com/bsteps/helpos/pull/297#issuecomment-6809374284)                                                 |

All originals remain open and frozen. Their branches, commits, and discussions are preserved. #312 and all other integration trackers are excluded from the original issue denominator.

## Commit mapping

Merge commit `2f49eed3b2e227efded9b99df3129bdba0171a0e` has parents `8af8f1f3f598b2d4ecfb4a1dcae0222b45f52551` and `5b0a05957b2d547781718cc0abf520d548fd61ae`. The integration merges the selected tip into current main. Every source commit keeps its exact identity, parent, and contents. The complete selected range is `git rev-list --reverse 0cb5ba8..5b0a059`. It contains only these seven commits.

| Source | Original commit, also the integration commit | Change                                                                 |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| #198   | `2326ebf7a0486572cb4600653113789e6862edec`   | Remove dead code and restore app export checks                         |
| #198   | `0ae82176a18d595c94179cd2d4f3b25609cd2f30`   | Reconfirm send-model semantics after dead system-job removal           |
| #241   | `d92d7620f211d44e8d416f4653de08eaec2dc856`   | Separate unit and integration projects, including 13 renames           |
| #241   | `a40db3e59e2faba2138e0f33da291f777cf33f7b`   | Execute unit tests with Docker service and socket stopped in hosted CI |
| #200   | `0191ad69282c9e4fc919fc3611f9100002930c28`   | Observe tenant job settlement before non-event assertions              |
| #200   | `0ae11c847e6d78b8720d1e5f3af61b634810d1f2`   | Reject deferred jobs before no-effect assertions                       |
| #200   | `5b0a05957b2d547781718cc0abf520d548fd61ae`   | Settle inbound jobs before concurrent budget assertions                |

No unselected ancestor is introduced after the shared base. No cherry-pick duplicates the selected commits. Main's approved migration and proof work remains inherited once.

## Rename mapping and content proof

Each of #241's 13 renames is byte-identical between its original parent and its source head. Every destination in this integration equals the corresponding PR297 blob. Thus later #200 edits to the draft, knowledge, and job tests survive intact rather than reverting to the earlier rename snapshot.

| Original path                                             | Integration path                                           |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/server/src/app.test.ts`                             | `apps/server/src/app.int.test.ts`                          |
| `apps/server/src/inbound-email/route.test.ts`             | `apps/server/src/inbound-email/route.int.test.ts`          |
| `apps/server/src/workspaces/init-workspace.test.ts`       | `apps/server/src/workspaces/init-workspace.int.test.ts`    |
| `packages/db/src/auth.test.ts`                            | `packages/db/src/auth.int.test.ts`                         |
| `packages/db/src/client.test.ts`                          | `packages/db/src/client.int.test.ts`                       |
| `packages/db/src/jobs.test.ts`                            | `packages/db/src/jobs.int.test.ts`                         |
| `packages/db/src/leak.test.ts`                            | `packages/db/src/leak.int.test.ts`                         |
| `packages/db/src/migrate-conversation-scopes.test.ts`     | `packages/db/src/migrate-conversation-scopes.int.test.ts`  |
| `packages/db/src/migrate-unique-knowledge-url.test.ts`    | `packages/db/src/migrate-unique-knowledge-url.int.test.ts` |
| `packages/db/src/schema.test.ts`                          | `packages/db/src/schema.int.test.ts`                       |
| `apps/server/src/knowledge/knowledge.test.ts`             | `apps/server/src/knowledge/knowledge.int.test.ts`          |
| `packages/db/src/knowledge.test.ts`                       | `packages/db/src/knowledge.int.test.ts`                    |
| `apps/server/src/drafts/drafts.test.ts`                   | `apps/server/src/drafts/drafts.int.test.ts`                |
| `packages/db/src/migrations.test.ts`, inherited from main | `packages/db/src/migrations.int.test.ts`                   |

The last row is the only additional integration rename. Its bytes match main exactly, preserving both schema consistency and repeat-setup assertions. The filename guard rejects its original name because it imports the real database helper. The inherited [migration proof manifest](278-verification-foundation.md) and [source review](https://github.com/bsteps/helpos/pull/250#issuecomment-6806701982) remain applicable to its unchanged assertions. Fresh execution covers its new project selection.

The reusable local maps remain at `E:/Projects/helpdesk/.helpos/autopilot/241-rename-map.tsv` and `E:/Projects/helpdesk/.helpos/autopilot/200-test-path-mapping.tsv`. Later source groups must apply their original-path edits to these destinations. Existing `notice-worker.int.test.ts`, `send-failed.int.test.ts`, `send-invariants.int.test.ts`, `send-path-replay.int.test.ts`, and `github.int.test.ts` retain their paths.

## Integration edits and conflicts

- The only merge conflict is the AGENTS enforcement table. All 21 main rules survive exactly once, including migration consistency and proof requirements. The added test-filename rule occurs once. Renamed database test pointers use their integration filenames.
- Main's migration test is renamed without content changes. All non-AGENTS files changed by the source chain match the selected source tip byte for byte. No production integration edit is required.
- The merge retains the source budget-race repair and deferred-work rejection. It retains the XSS frame-load and two-render-frame barrier, the malicious fixture assertions, and the existing send-model coverage record.

The structure remains the source design. `unit` excludes `*.int.test.ts` and has no Postgres setup. `int` selects those files and owns database setup. `waitForTenantJobs` observes tenant-filtered pg-boss rows, keeps queued, active, and retry work pending, and returns future created work separately. Application outcome assertions remain necessary after settlement.

## Inherited proof and separate groups

The [PR296 hosted run](https://github.com/bsteps/helpos/actions/runs/43114634471/job/130839317561) actually stopped both Docker service and socket on a disposable hosted runner. It executed 599 unit tests across 49 files successfully before restoring Docker and running uncached integration checks. The final independent verdict checked its merge-tree equality and log provenance. This is reused source evidence, not a new stopped-daemon run of this integration. Shared Docker is never stopped here. Unit source files and unit configuration are unchanged from that source.

The PR276 verdict covers the removed unused system-job branch, tenant transaction and last-failure semantics, targeted source mutations, and the send model. The PR297 verdict covers worker controls, caller outcomes, the budget race, and fresh laptop and phone XSS checks against the composed API with deterministic AI adapters. These unaffected results are reused with their stated limits. Existing model findings are preserved. No new formal verification or blanket fingerprint confirmation is claimed.

| Separate group                                                                                               | Concrete overlap and later reconciliation                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PR311](https://github.com/bsteps/helpos/pull/311), reviewed head `cada3c578a45695697f573ee7a5ef07db573ab83` | Excluded. If it lands, map its new `packages/db/src/migrate-knowledge-state.test.ts` to `packages/db/src/migrate-knowledge-state.int.test.ts`. Map edits to both original `knowledge.test.ts` paths using the table above. Do not create a future stub. Reconcile only a real main change.                                                                                                                                                                                            |
| [PR309](https://github.com/bsteps/helpos/pull/309)                                                           | Quality and coverage gates belong to the later group. This integration makes no combined-coverage claim.                                                                                                                                                                                                                                                                                                                                                                              |
| [PR269](https://github.com/bsteps/helpos/pull/269), head `e130503f7c97ce5edefd3ed8add7592bf8406a39`          | Both remove `brand.npmScope`, `brand.tagline`, the npm-scope assertion, and DB re-exports `defineSystemJob`, `SystemJob`, and `SystemJobHandler`. #198 removes the unused system-job implementation entirely. Later #269 must not restore its private system types or overloads. Keep #198's removed app export ignores and `ignoreBinaries: ["java"]` while adding #269's package `includeEntryExports`. Its other package export edits and `scripts/knip.test.mjs` remain excluded. |

## Fresh combined proof

Focused checks completed before full verification, with fixture and mutation runs serialized:

- Root Vitest collection and each of seven package collections select all 79 source test files exactly once. The split is 49 unit files and 30 integration files. The new queue-helper test and main's migration test explain the two integration files beyond #241's source inventory.
- `node --test scripts/integration-test-names.test.mjs` passes. Temporarily restoring ordinary names for server `app` and DB `migrations` makes the real guard reject both. Restoring the filenames returns all three guard tests to passing.
- `node scripts/prove-job-waits.mjs` passes its five real-Postgres queue tests before and after three mutations. Ignoring queued or active work fails the held-worker timeout assertions. Ignoring retry backoff returns `retry` instead of terminal `failed`, failing the expected-state assertion. Each source mutation is restored byte for byte.
- A restored budget-barrier probe holds the real inbound worker. Omitting the drain lets its reservation fall from 6,104 to 3,178 and incorrectly makes the concurrent cap assertion expect a rejection when the second request returns 200. With the drain present, the held worker causes an active-job timeout until release, then the cap assertions pass. Production budget code is unchanged.
- Fresh DB execution passes 49 tests across queue controls, migration consistency, jobs, and tenant leaks. Fresh execution of the five affected server integration files passes 177 tests. Fresh access-unit execution passes 135 tests.
- `pnpm test:scripts` passes 103 tests without skips. This includes the real Knip export negative fixture and its restored pass, workflow checks, filename guard, proof CLI, and inherited send-checker controls.
- Deslop finds no required changes. The single fresh native Comment Sicko child finds zero required deletions, suppressions, or open constraints. The queue-helper doc comment defines its public contract. This is a same-model review, not the later independent integration review.

Local rerunnable comparison and probe artifacts are in this checkout's `.helpos/`. `prove-312.mjs` checks all rename bytes, selected source files, AGENTS rules, all package collections, and the restored filename negative proof. `312-equivalence.json` records the results. Queue mutations retain their individual assertion logs under `job-wait-mutations/`. `312-race-probe.mjs`, `297-race-without-drain.log`, and `297-race-fixed-barrier.log` retain the reproduced race and fixed control. A Windows escaped-path assumption in the comparison script was corrected after its output assertion failed. The guard itself rejected both intended filenames and restored them correctly.

The initial verification attempt stopped at Markdown table formatting before Knip or package tasks ran. Formatting the two integration documents fixes that failure without source changes. The required publication gate is one completed `pnpm verify` run on the stable committed combined head after all transient fixtures are restored. The replacement PR and append-only decision log record its exact SHA, result, cache use, and any limitation. Fresh independent integration review and required hosted CI remain separate gates.

## Risks, limits, and human review

Removing unused exports changes internal import availability, including the unused system-job API. Current callers, scoped access, tenant routing, and source send semantics remain intact. The filename guard detects literal AST imports, including relative and dynamic imports. It does not classify arbitrary computed or transitive dependencies.

Job settlement requires the producer transaction to have committed and the relevant workers to be running. It cannot prevent a later unrelated producer from adding work. Failed or cancelled jobs are terminal queue states, not proof of application success. Deferred work is not executed or rescheduled by the helper. Known duplicate-delivery, hidden-delivery, lost-retry, worker-death, and give-up findings remain unresolved where documented by the existing send evidence.

The proof gate sees the inbound test rename and the removal of `export` from `shadowBanner` as email changes. No parser, transport, or message output changes, so the PR records the supported explicit proof exception rather than adding an unrelated fixture edit. Existing mail, recipient, header, audit, and XSS assertions remain present. That exception is visible for human review and does not claim new email behavior proof.

#205 is explicitly deferred because credentials are unavailable, outside actionable scope, and never a blocker for this integration. No credentials are requested and no live Claude or Anthropic call is made. Offline and mock checks prove deterministic machinery, prompt transport, and assertions. They do not prove live model quality or injection resistance.

Codex `gpt-6.1-sol` with xhigh reasoning prepares this integration. PR276 records Astra authorship with Sol review. PR296 and PR297 record Codex authorship and fresh same-model review. Original provenance is retained. Root owns the later fresh independent integration review and CI handoff. Keep `pr:in-progress` and `needs-human` until findings are cleared. Never apply `land`. No merge, approval, closure, branch deletion, source push, or settings change is part of this work.

The decision trail is `E:/Projects/helpdesk/.helpos/autopilot/312-integration.tsv`. Environment bytes are preserved. Database checks use owned throwaway Testcontainers databases, not another worktree's database. No application process is started.
