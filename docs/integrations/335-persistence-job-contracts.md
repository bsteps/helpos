# Persistence and stored job contracts integration

Finish only the remaining #196 and #228 cleanup. Typed allowed lists own scalar enum CHECK values and workspace role types. A malformed stored job reports a fixed final failure with queue and job ID before any typed callback receives it.

## Exact prerequisites

The branch is `335-persistence-job-contracts`. Its starting commit is [PR334](https://github.com/bsteps/helpos/pull/334), branch `329-auditable-operations`, at `4cbbdc13e31a4de6a743a53378eb2b2e2946a192`. The explicit second prerequisite is published [PR336](https://github.com/bsteps/helpos/pull/336), branch `328-ai-consumer-boundaries`, at `41f08b6feecd7ed25a160a8beb5d6775db1085bc`. Their merge base is `80d10689dc1fe917c8f6364d5015edee9b7ad90e`. Normal merge `031a4359664fceb6ff255fb3a4044ebff98f26ce` has those exact first and second parents. Neither prerequisite is a newly assigned original.

The tracker's older PR336 pin `574a4fde3586debd0cd8d62271b32928acf9248f` remains an ancestor. Its successor `41f08b6` changes only manifest formatting and its trail. Published `41f08b6` is the assembly prerequisite. The dependent PR targets `329-auditable-operations`, with PR336 named as its second prerequisite. The root finalizes the base later. The initial diff includes that second prerequisite and does not claim equivalence with main.

The [auditable operations record](329-auditable-operations.md) and [AI consumer record](328-ai-consumer-boundaries.md) retain their frozen source mappings, runtime proof, and limits. Migration 0022 typed knowledge, 0023 uncertain-send, and 0024 audit details remain unchanged. Actor types, AuditContext, two-phase send, MIME, the public conversation API's unconfirmed-history filter, worker scopes, remaining failure allowance including zero, and the deletion of the dead system-job API remain prerequisites. Current #241 integration filenames and #200 waits remain in place. The unchanged AI history query does not filter `sentAt` and may include prepared outbound rows. No AI-prompt exclusion proof is claimed.

## Selected source deltas

Only two originals are selected. Merge bases below are the same against either prerequisite head.

| Original                                                  | Frozen head                                | Unique delta base                          | Merge base with prerequisites              | Inherited independent review                                                    |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| [#196 / PR284](https://github.com/bsteps/helpos/pull/284) | `40b306329dd737172ea83e45facb2cc54b091bd0` | `7ad8b560bcf23033c31712cc0fe013cfa7fff2bd` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/284#issuecomment-6807436619) |
| [#228 / PR260](https://github.com/bsteps/helpos/pull/260) | `3d6af56b279ef2a9ec45fa407f58a4256f8e3f4f` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/260#issuecomment-6805592098) |

PR284 contains one unique commit. Its migration-check ancestors are already integrated and are excluded. PR260 contains the malformed-job regression and its fix. Each source commit is applied once with its original author, authored date, and `cherry-pick -x` trailer.

| Original commit                            | Applied commit                             | Change                                                                 |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `40b306329dd737172ea83e45facb2cc54b091bd0` | `9eec78dc939c9b6919d157ae6a874e7f032b19cb` | Derive scalar CHECKs and workspace role types from allowed lists.      |
| `c5022aa248df51f9df8bc782dd8d2f035dfc6219` | `54c742eff43796cf132ecf1a3dd566790ca9e91a` | Retain the real malformed-job regression in both worker modes.         |
| `3d6af56b279ef2a9ec45fa407f58a4256f8e3f4f` | `6709daf6c604191cc0a74cc0e69089db6b151f8a` | Report final invalid payload failure and preserve safe logger context. |

Git receipts identify Nishant Tadvi <nishant.tadvi@yahoo.com> as the source author. The independent source reports identify GPT-6 Astra high authorship and GPT-6-sol xhigh verification. This assembly uses GPT-6.1-sol xhigh. Those reports establish model provenance; Git metadata alone does not. Incomplete advisory AI checks are not substantive review evidence.

## Actual conflicts and ports

The prerequisite merge had five conflicted files.

| File                             | Resolution                                                                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drafts/draft-worker.ts`         | Keep shared paid-model and refusal mapping from PR336. Keep PR334's `pauseAi` domain operation and Actor audit ownership. Remove the stale direct-audit import.                                                                                                                                         |
| `drafts/routes.ts`               | Keep PR334's extracted regenerate call rather than restore its old inline implementation. Move PR336's `dailyBudgetRefusal` and `mapAiRefusal` into `regenerateDraft` in `drafts/lifecycle.ts`. Preserve checks before discard, exact result values, clear-pause operation, enqueue, and audit details. |
| `biome.json`                     | Keep both conversation-write and paid-AI enforcement.                                                                                                                                                                                                                                                   |
| `scripts/biome-plugins.test.mjs` | Keep both sets of rule regressions.                                                                                                                                                                                                                                                                     |
| `verify-send-reply/SKILL.md`     | Combine the selective conversation/audit and AI-runner alignment notes. Preserve each parent's current rows.                                                                                                                                                                                            |

The #196 pick conflicted only in `schema.ts`. The current `draftStatuses` already includes `send_uncertain`; the helper uses that complete unchanged list. Keep the complete `knowledge_sources_state` JSON CHECK and nonnegative retry-count CHECK from 0022. Only its kind, visibility, and managed-by scalar checks use the new helper. Keep audit details and imported shared Actor types.

The source had 14 scalar enum CHECKs. Migration 0022 removed the old `knowledge_sources_status` column and CHECK in favor of typed JSON state before this assembly. Therefore 13 scalar enum CHECKs remain to convert. The obsolete source catalog row is omitted; the existing typed-state tests and CHECK remain. Reintroducing that column to retain a historical count would change the schema and violate the task. All 13 surviving names and allowed values match the assembled prerequisites. Workspace roles remain exactly `owner` and `member`.

The #228 regression automatically follows the current `jobs.int.test.ts` filename. The fix conflicted only at payload parsing in `createJobRunner.consume`. Keep the current generic tenant-only wrapper and its `retryLimit - retryCount` argument. Port `safeParse`, the fixed error, final-attempt error hook, and queue/job ID context. The validated `parsed.data` already has type `P`, so the stale source cast is unnecessary. No retry policy or worker signature changes.

Invalid data reaches neither the handler nor `onGiveUp`, because either would require a validated tenant payload. pg-boss records the fixed error and handles its existing retries. The server logger receives queue and job ID, while its error serializer retains the error summary rather than its raw message. No raw stored payload, validation details, customer content, or tenant ID is sent to that diagnostic.

## Selective model correspondence

Only `createJobRunner.consume` changes a covered function body. Its fingerprint changes from `1c5921f6eb32` to `23141a4a4b69`. For valid payloads, handler invocation, remaining retry allowance, rollback-before-give-up, final-attempt condition, rethrow, and pg-boss settlement remain in the same order. `createJobRunner.work` remains `0ac5978b52bb`, `defineJob` remains `313382219f6f`, and enqueue SQL remains `1e14891501d5`. All remaining coverage rows match.

The model, mutants, checker, checker regression, mutation driver, constants, dependency version, and configuration generator equal the PR334 inputs. PR336 preserves those same inputs. Reuse the 36 frozen reviewed outcomes under their original assumptions. No blanket confirmation, TLC run, statechart campaign, or optional source mutation fleet is needed for these unchanged inputs.

The model assumes valid tenant job payloads. It does not establish malformed-job observability. The original real pg-boss regression checks both transaction and steps modes, final failed state, exactly one error hook, absence of both typed callbacks, and safe recorded output. The composed-server regression checks logger context and redaction after schema drift. Those are the runtime proof for this boundary. Known lost-retry and failed-give-up `NoSilentStall` findings remain open. No new send-safety promise is made.

## Light verification and remaining gates

Worktree setup completed before assembly. No parent branch or original source is rewritten or pushed. The throughput boundary keeps units, compiler, schema structure, and provenance checks separate from coordinator-allocated Postgres and full verification.

Fresh light checks pass.

- Workspace typechecking passes all seven tasks. DB and server execute fresh; five prerequisite-compatible tasks use cache.
- Server unit tests pass 495 cases in 36 files. DB units pass seven cases in two files.
- The five affected repo script files pass 55 tests. These cover both lint boundaries, import ownership, integration filenames, paid-handle compiler contracts, and ADR test pointers.
- The two selected fingerprint regressions pass without starting TLC.
- `pnpm --filter @helpos/db generate` reports no schema changes. No migration, snapshot, or journal changes result.
- A direct Drizzle comparison against assembled prerequisite merge `031a435` matches all 20 tables' column types, enums, nullability, defaults, CHECK SQL, RLS flags, and policies. This is structure equivalence, not a fresh PostgreSQL catalog run.
- Provenance assertions verify merge parents, all three original/applied authors and authored dates, `-x` trailers, once-only receipts, and protected prerequisite files. The source #196 negative catalog proof remains inherited. Fresh combined catalog and malformed-job runtime execution is recorded below.
- Biome and Knip pass. The inherited void-union advisory and two sync-labels environment warnings remain. No suppression or dependency is added.

Local rerunnable light artifacts are `.helpos/335-schema-equivalence.mjs`, `.helpos/335-provenance.mjs`, `.helpos/335-provenance.json`, and `.helpos/335-fingerprints.mjs`. The fingerprint probe verifies all current coverage rows and unchanged model inputs. The targeted repository regression validates the updated coverage record. An initial probe also saw a CRLF-only template fingerprint difference after conflict editing; formatting restored LF and the original enqueue SQL fingerprint. No SQL or model change was needed.

The one native same-model GPT-6.1-sol xhigh Comment Sicko/deslop pass found no required changes. It edited no files and deleted no comments. No `MUST KILL` flags, new suppressions, unsafe casts, or open constraints were found. Unchanged predecessor comments were excluded. The result is appended to the trail. Fresh independent integration review remains root-owned and is separate from this cleanup pass.

## Bounded Postgres proof

The root granted exactly eight prepared suites on one owned PostgreSQL container, capped at 512 MiB and one CPU. At unchanged production head `efbab5f0e136db139cf043528dd3ff7602399c04`, the single process passed all eight files and 96 tests in 50.55 seconds, exit 0. It used `--project int --maxWorkers 1` with file parallelism disabled. No test, schema, type, or production fix was needed.

The DB suites were `schema.int.test.ts`, `migrations.int.test.ts`, `jobs.int.test.ts`, and `leak.int.test.ts`. The server suites were `invalid-job.int.test.ts`, `drafts/regenerate.int.test.ts`, `ai-budget/busy-queue.int.test.ts`, and `ai-budget/busy-retries.int.test.ts`. They verify the 13 current scalar enum catalogs, generated-schema no-op, migration/job installation idempotence, audit-details legacy data and rollback, tenant isolation, malformed-job final failure in both worker modes, composed-server safe logger context, regenerate sequencing, repeated busy deferrals, and remaining failure allowance including zero. These are existing real runtime tests. No new mutation campaign or malformed-payload formal claim is made.

The local config `.helpos/335-vitest.config.mts` selects exactly those eight paths. The setup wrapper `.helpos/335-capped-setup.ts` applies Testcontainers resource quotas before invoking the unchanged repository setup and asserts Docker's actual limits. Docker inspection records `Memory=536870912` and `NanoCpus=1000000000` for owned container `a0d0777587411b1048b04f34c5c0a9745e2005f2f269887f8ffd02590a1fa999`. The wrapper is untracked local orchestration; no repository setup or test code changes.

The process exited 0 and teardown completed at `2026-11-12T10:34:28.936Z`. Docker reports no remaining container with the #335 ownership label. The same three pre-existing containers remain. The bounded slot is released. Results and resource receipts are `.helpos/335-focused-pg.log`, `.helpos/335-focused-pg.exit`, `.helpos/335-pg-resource.json`, and `.helpos/335-pg-teardown.json`.

## Active dependency correction before the full gate

The root explicitly requested current PR336 `c5f23a5bdefd9c5c67ec2b2c6ce4a6155c0c1d32` before the granted final gate. Normal merge `e251f94c41f552f04b003f9e95fe2192b450f09f` has first parent `b58efb9dbf5ba425f2e154e3220367ba5badc181` and second parent `c5f23a5`. It has no conflicts. Original prerequisite pins `41f08b6` and `574a4fd`, initial prerequisite merge `031a435`, all three selected source receipts, and bounded-runtime head `efbab5f` remain ancestors.

The exact active-dependency delta is only `packages/ai/src/growth.testing.ts`, new `packages/ai/src/growth.test.ts`, and `docs/integrations/328-ai-consumer-boundaries.md`. Hosted CI exposed a below-floor sample in the inherited helper. Its bounded resampling correction keeps the existing 1024-batch maximum, seven paired samples, minimum sample duration, median ratio limit, and output checks. Three deterministic clock regressions cover faster post-warmup work, rejection of quadratic growth, and rejection below the floor at the cap. The history documentation now distinguishes the public API filter from the unchanged AI prompt history. No production, public type, model, schema, retry, scope, or audit contract changes. This is an active dependency test/doc correction, not another selected original or a source refresh.

Fresh selected execution passes 69 tests across `growth.test.ts`, `draft-reply.test.ts`, and `draft-issue.test.ts`. The first command used a `unit` project filter that the AI package does not define and stopped before running tests; the corrected package-local command passes. Receipts are `.helpos/335-growth-selected.log` and `.helpos/335-growth-selected-corrected.log`. These are test reliability checks, not a product speedup claim. The earlier bounded PG proof remains applicable to unchanged production code.

## Final gate and publication

The root granted the single plain `EVAL_LIVE=0 pnpm verify` after the bounded process exited and the other resource holders released their containers. It runs on the next stable committed head with valid cache, without `TURBO_FORCE`, source edits, TLC, a browser, or repeated `test:scripts`. Final SHA, outcome, fresh/cache split, and resource release belong in the PR and local runtime trail without changing the tested commit. A live app journey would require Docker and real AI under `verify-helpos`, so it is not run under this offline scope. Source role/API proof remains inherited. Offline checks do not prove live model quality or injection resistance. #205 remains deferred.

Publication waits for local readiness. The own-branch PR must retain `needs-human`, `security`, and `pr:in-progress`, target `329-auditable-operations`, and name PR336 explicitly. Link it immediately after creation. The root owns fresh independent integration review and final base choice. No source refresh, parent push, merge, approval, closure, deletion, settings change, or watch is authorized. The append-only [335-integration.tsv](335-integration.tsv) records decisions and outcomes.

## Independent review and security review

A fresh Claude Opus 5.5 review covered `4cbbdc1...cc9c062`, scoped to the three selected source commits, the conflict resolutions in `031a435`, and the integration risks of the inherited prerequisite. Standards and spec reviewers ran in separate contexts, and a third reviewer checked the fix. The conflict resolutions and both original contracts hold. Four gaps were fixed in one commit:

- A malformed payload logged only `job runner error` with error name `Error`, which looks like any pg-boss background error. It now throws `InvalidJobPayloadError`, so the log entry names the failure and still carries no message, payload or tenant ID.
- The composed-server regression passed on the first log line, so it would also pass if every attempt logged. It now waits for the job's `failed` state after its retry and requires exactly one entry.
- `ServerInput.onJobError` was typed without the queue and job ID context, so a caller's hook silently lost it. It now uses the runner's own `onError` type.
- The enum CHECK test compared only the 13 rows in its table. A new list CHECK left out of the table passed unnoticed. A guard now lists every public CHECK whose stored definition is an allowed-value list, including a one-value list such as `integrations_provider`, and requires each one in the table. A negative run that removed `integrations_provider` from the table failed as intended.

The `createJobRunner.consume` fingerprint moves from `23141a4a4b69` to `13c7c8ab11d4`. The last-attempt condition is computed once before validation, and the valid-payload order is unchanged. No other coverage row changes.

Not changed: the `knowledge_sources_state` JSON CHECK still types out its code and HTTP-status lists by hand, and public API Zod schemas restate some enum lists. Neither is in the scope of #196. A payload that is always invalid still uses every retry before its single log entry, as #228 asks.

`/security-review` ran on `4cbbdc1...2d28db6` and found no vulnerability at or above its reporting bar. It covered the `sql.raw` enum builder, role-derived scopes, malformed-payload tenant selection and content-safe output, busy-deferral re-enqueue, regenerate audit atomicity, knowledge search audience and the merged lint rules.

The coordinator's bounded grant ran `schema.int.test.ts`, `jobs.int.test.ts` and `invalid-job.int.test.ts` on one owned PostgreSQL with one worker and no file parallelism. Result: 3 files and 46 tests pass, exit 0. Light checks pass: DB and server typechecks, 495 server and 7 DB unit tests, and Biome with the three inherited warnings. Docker returned to its three baseline containers.
