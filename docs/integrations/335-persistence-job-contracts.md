# Persistence and stored job contracts integration

Finish only the remaining #196 and #228 cleanup. Typed allowed lists own scalar enum CHECK values and workspace role types. A malformed stored job reports a fixed final failure with queue and job ID before any typed callback receives it.

## Exact prerequisites

The branch is `335-persistence-job-contracts`. Its starting commit is [PR334](https://github.com/bsteps/helpos/pull/334), branch `329-auditable-operations`, at `4cbbdc13e31a4de6a743a53378eb2b2e2946a192`. The explicit second prerequisite is published [PR336](https://github.com/bsteps/helpos/pull/336), branch `328-ai-consumer-boundaries`, at `41f08b6feecd7ed25a160a8beb5d6775db1085bc`. Their merge base is `80d10689dc1fe917c8f6364d5015edee9b7ad90e`. Normal merge `031a4359664fceb6ff255fb3a4044ebff98f26ce` has those exact first and second parents. Neither prerequisite is a newly assigned original.

The tracker's older PR336 pin `574a4fde3586debd0cd8d62271b32928acf9248f` remains an ancestor. Its successor `41f08b6` changes only manifest formatting and its trail. Published `41f08b6` is the assembly prerequisite. The dependent PR targets `329-auditable-operations`, with PR336 named as its second prerequisite. The root finalizes the base later. The initial diff includes that second prerequisite and does not claim equivalence with main.

The [auditable operations record](329-auditable-operations.md) and [AI consumer record](328-ai-consumer-boundaries.md) retain their frozen source mappings, runtime proof, and limits. Migration 0022 typed knowledge, 0023 uncertain-send, and 0024 audit details remain unchanged. Actor types, AuditContext, two-phase send, MIME, hidden unconfirmed history, worker scopes, remaining failure allowance including zero, and the deletion of the dead system-job API remain prerequisites. Current #241 integration filenames and #200 waits remain in place.

## Selected source deltas

Only two originals are selected. Merge bases below are the same against either prerequisite head.

| Original | Frozen head | Unique delta base | Merge base with prerequisites | Inherited independent review |
| --- | --- | --- | --- | --- |
| [#196 / PR284](https://github.com/bsteps/helpos/pull/284) | `40b306329dd737172ea83e45facb2cc54b091bd0` | `7ad8b560bcf23033c31712cc0fe013cfa7fff2bd` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/284#issuecomment-6807436619) |
| [#228 / PR260](https://github.com/bsteps/helpos/pull/260) | `3d6af56b279ef2a9ec45fa407f58a4256f8e3f4f` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/260#issuecomment-6805592098) |

PR284 contains one unique commit. Its migration-check ancestors are already integrated and are excluded. PR260 contains the malformed-job regression and its fix. Each source commit is applied once with its original author, authored date, and `cherry-pick -x` trailer.

| Original commit | Applied commit | Change |
| --- | --- | --- |
| `40b306329dd737172ea83e45facb2cc54b091bd0` | `9eec78dc939c9b6919d157ae6a874e7f032b19cb` | Derive scalar CHECKs and workspace role types from allowed lists. |
| `c5022aa248df51f9df8bc782dd8d2f035dfc6219` | `54c742eff43796cf132ecf1a3dd566790ca9e91a` | Retain the real malformed-job regression in both worker modes. |
| `3d6af56b279ef2a9ec45fa407f58a4256f8e3f4f` | `6709daf6c604191cc0a74cc0e69089db6b151f8a` | Report final invalid payload failure and preserve safe logger context. |

Git receipts identify Nishant Tadvi <nishant.tadvi@yahoo.com> as the source author. The independent source reports identify GPT-6 Astra high authorship and GPT-6-sol xhigh verification. This assembly uses GPT-6.1-sol xhigh. Those reports establish model provenance; Git metadata alone does not. Incomplete advisory AI checks are not substantive review evidence.

## Actual conflicts and ports

The prerequisite merge had five conflicted files.

| File | Resolution |
| --- | --- |
| `drafts/draft-worker.ts` | Keep shared paid-model and refusal mapping from PR336. Keep PR334's `pauseAi` domain operation and Actor audit ownership. Remove the stale direct-audit import. |
| `drafts/routes.ts` | Keep PR334's extracted regenerate call rather than restore its old inline implementation. Move PR336's `dailyBudgetRefusal` and `mapAiRefusal` into `regenerateDraft` in `drafts/lifecycle.ts`. Preserve checks before discard, exact result values, clear-pause operation, enqueue, and audit details. |
| `biome.json` | Keep both conversation-write and paid-AI enforcement. |
| `scripts/biome-plugins.test.mjs` | Keep both sets of rule regressions. |
| `verify-send-reply/SKILL.md` | Combine the selective conversation/audit and AI-runner alignment notes. Preserve each parent's current rows. |

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
- Provenance assertions verify merge parents, all three original/applied authors and authored dates, `-x` trailers, once-only receipts, and protected prerequisite files. The source #196 negative catalog proof and #228 real malformed-job proof remain inherited evidence until rerun on this combined tree.
- Biome and Knip pass. The inherited void-union advisory and two sync-labels environment warnings remain. No suppression or dependency is added.

Local rerunnable light artifacts are `.helpos/335-schema-equivalence.mjs`, `.helpos/335-provenance.mjs`, `.helpos/335-provenance.json`, and `.helpos/335-fingerprints.mjs`. The fingerprint probe verifies all current coverage rows and unchanged model inputs. The targeted repository regression validates the updated coverage record. An initial probe also saw a CRLF-only template fingerprint difference after conflict editing; formatting restored LF and the original enqueue SQL fingerprint. No SQL or model change was needed.

The one native same-model GPT-6.1-sol xhigh Comment Sicko/deslop pass found no required changes. It edited no files and deleted no comments. No `MUST KILL` flags, new suppressions, unsafe casts, or open constraints were found. Unchanged predecessor comments were excluded. The result is appended to the trail. Fresh independent integration review remains root-owned and is separate from this cleanup pass.

The focused resource need is one serial Postgres slot using `--project int --maxWorkers 1`. The DB selection is `schema.int.test.ts`, `migrations.int.test.ts`, `jobs.int.test.ts`, and `leak.int.test.ts`. The server selection is `invalid-job.int.test.ts`, `drafts/regenerate.int.test.ts`, `ai-budget/busy-queue.int.test.ts`, and `ai-budget/busy-retries.int.test.ts`. These prove the new boundary and the prerequisite conflict ports with the existing real runtime tests. No fresh negative mutation campaign is requested.

No Docker, TLC, or full run starts without the root's concrete resource grant. After focused proof and a stable committed tree, one plain `EVAL_LIVE=0 pnpm verify` with valid cache is required. Final SHA, outcome, and fresh/cache split belong in the PR and local runtime trail without changing the tested commit. A live app journey would require Docker and real AI under `verify-helpos`, so it is not run under this offline scope. Source role/API proof remains inherited. Offline checks do not prove live model quality or injection resistance. #205 remains deferred.

Publication waits for local readiness. The own-branch PR must retain `needs-human`, `security`, and `pr:in-progress`, target `329-auditable-operations`, and name PR336 explicitly. Link it immediately after creation. The root owns fresh independent integration review and final base choice. No source refresh, parent push, merge, approval, closure, deletion, settings change, or watch is authorized. The append-only [335-integration.tsv](335-integration.tsv) records decisions and outcomes.
