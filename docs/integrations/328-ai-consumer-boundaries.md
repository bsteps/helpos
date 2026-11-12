# AI consumer boundaries integration

This assembly finishes #207, #203, and #204 before feature work. Paid AI consumers use the existing budget, busy jobs retain their remaining failure allowance, and knowledge callers choose the audience.

## Prerequisites and frozen sources

The first parent is [PR319](https://github.com/bsteps/helpos/pull/319), branch `316-ai-text-bounds`, pinned at `a598901ef0aca629d8579071356566cd856836c8`. The second prerequisite is [PR315](https://github.com/bsteps/helpos/pull/315), branch `314-reply-safety`, pinned at `80d10689dc1fe917c8f6364d5015edee9b7ad90e`. Both descend from actual main `58451595845f67aef0fb35e0ba584bac71ad1045`, their merge base. Local merge `6461d484c8600d4aada51a6589b40de4c5fe68a3` has those exact parents in that order and needs no conflict resolution. Neither prerequisite is a newly assigned source.

The dependent PR initially targets `316-ai-text-bounds`. Its diff also contains the second prerequisite until the coordinator updates the base after approved prerequisite landing. It does not claim parity with main. Neither prerequisite nor any original branch is refreshed, rewritten, or pushed by this task. Source changes for #326, #327, and #329 are excluded.

| Original | Frozen head | Unique delta base |
| --- | --- | --- |
| [PR290, #207](https://github.com/bsteps/helpos/pull/290) | `59960e1b567a345acc019d95fc60c0f0fc08d5b0` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` |
| [PR293, #203](https://github.com/bsteps/helpos/pull/293) | `636bab4bee0dd9e16f7edfccf3ca2e246b668e15` | `59960e1b567a345acc019d95fc60c0f0fc08d5b0` |
| [PR295, #204](https://github.com/bsteps/helpos/pull/295) | `2e3e6afb449adf568b764681a88d0c51d37c8370` | `636bab4bee0dd9e16f7edfccf3ca2e246b668e15` |

The source/main merge base is `0cb5ba823f010b8fb0ec7ac6061faeb673d31658`. Adjacent source merge bases equal the unique delta bases above. PR295 has parents `0df1c2bbd98a55cafecba10b30f64e4870f80710` and `636bab4bee0dd9e16f7edfccf3ca2e246b668e15`. Its merge only incorporates the already applied allowance fix. Applying its one unique non-merge commit avoids duplicating that fix or importing old parent history.

All nine unique source commits retain Git author Nishant Tadvi <nishant.tadvi@yahoo.com>, original author timestamps, and `cherry picked from commit` trailers. The source review reports attribute initial #207 and #203 implementation to GPT-6 Astra, subsequent boundary/allowance fixes to GPT-6.1-sol xhigh, and #204 to GPT-6.1-sol xhigh. This assembly uses GPT-6.1-sol xhigh. Git metadata does not independently establish model provenance.

| Unique source commit | Applied commit | Change |
| --- | --- | --- |
| `c052eda5a0b605591e294c18473e1f3c9879cee8` | `5f99a84179c2e5a3eeeb081425ebe17496ecf2e5` | fix(ai): require paid model handles for AI calls |
| `033b95cdebe205b21fca6286c99ab7f82f5d4ddf` | `d4f08eab80fe2ac27258c29d16eeef1632711e78` | test: reproduce paid AI namespace re-export bypasses |
| `59960e1b567a345acc019d95fc60c0f0fc08d5b0` | `bf70f34b4c8e7cabb7f1ecae36cafde93863de11` | fix: enforce paid AI boundary on namespace re-exports |
| `70ae631101b88266b0818a46c8aa62f2aabca80b` | `3496329c047d8ef5c310bdad7f9fd788eba95db2` | fix(ai-budget): defer busy workers without failed attempts |
| `cd87affb3d9eb187a123708f80274886200c83d9` | `006ec800bab1ecb0f84af9d94a73412bda987f34` | refactor(ai-budget): map regenerate refusals through shared result |
| `ec827e3e6b7005a37b041bc4dfb4f12d7d4ca256` | `8cb0ad8477bd574d5d95c90b08b0d795a66e898d` | test: reproduce retry allowance reset after busy deferrals |
| `5859edc9010422c133208b91c613c349f15fd835` | `5b9b7f62b1bcc8484d24ace636065549729a020b` | fix: preserve failure allowance across busy job deferrals |
| `636bab4bee0dd9e16f7edfccf3ca2e246b668e15` | `7928ea8e8e4ec8f2ce04c709502b1112942492fa` | docs: confirm send runner coverage after deferral fix |
| `0df1c2bbd98a55cafecba10b30f64e4870f80710` | `9af285259969c0a28df4cfeb2235e0237e7fb7de` | fix(knowledge): require an audience for passage searches |

## Inherited review limits

- [PR290 PASS+NOTES](https://github.com/bsteps/helpos/pull/290#issuecomment-6808049529) at the pinned head supersedes the [namespace-export FAIL](https://github.com/bsteps/helpos/pull/290#issuecomment-6807878739). The fixed matcher and four regression cases are retained without exceptions.
- [PR293 PASS+NOTES](https://github.com/bsteps/helpos/pull/293#issuecomment-6808959835) supersedes the [retry-allowance FAIL](https://github.com/bsteps/helpos/pull/293#issuecomment-6808277658). Its real queue, zero-allowance, rollback, and after-commit probes are prior evidence. They do not establish every crash interleaving.
- [PR295 PASS+NOTES](https://github.com/bsteps/helpos/pull/295#issuecomment-6808834506) covers the exact eight-file audience delta against the fixed #203 parent. It includes type, public-only preflight, indexed filtering, tenant, and offline browser proof.

These source reviews apply only to unchanged source behavior. They do not approve integration edits or replace fresh independent integration review. Prerequisite review evidence stays in [314-reply-safety.md](314-reply-safety.md) and [316-ai-text-bounds.md](316-ai-text-bounds.md). Successful advisory workflows that reported incomplete reviews are not substantive reviews. No human approval is inherited.

## Actual integration mappings

The data shapes remain `PaidModel<M>`, `PaidModels`, `AiRefusal`, `JobDeferral`, and a required `approver | customer` audience. No new abstraction, migration, dependency, or product policy is added. The integration maps the frozen deltas onto accepted prerequisite contracts.

| File or consumer | Integration mapping and retained contract |
| --- | --- |
| `AGENTS.md` | Add the paid-handle enforcement row to the current rules table. Keep migration checks, proof gates, and `.int.test.ts` names. |
| `ai-budget/budget.ts`, `github/issue-draft.ts` | Exact frozen final source. `spend` owns the paid callback, abort signal, lifetime and zero SDK retries. Refusals use the shared mapper. Existing reservation and settlement SQL stays intact. |
| `drafts/draft-worker.ts` | Combine paid model factory and typed deferral with PR315 `builtInActors` and its audit context. Explicit `approver` search retains internal notes and citations. Keep exclusion of unconfirmed outbound messages from history. |
| `drafts/routes.ts` | Apply shared daily-refusal mapping before any stale draft is discarded. Keep PR315 `context` rather than restoring the old audit callback. Scope, response, and lifecycle checks remain. |
| `knowledge/ingest-worker.ts` | Keep the extracted page fetcher, source operations, typed state and `builtInActors`. Add `JobDeferral` without restoring old parser, safe-fetch or direct-enqueue imports. Busy returns the current-source deferral after `lockIfCurrent`; it preserves reason, retry time and retryCount. |
| `knowledge/search.ts` | Exact frozen source. Query derives its audience from `KnowledgeQuery`. Query embedding requires the caller's paid factory. DB preflight and vector retrieval share the DB audience predicate. |
| `knowledge/knowledge.int.test.ts` | Apply former `knowledge.test.ts` edits to the current integration suite. Keep `waitFor`, typed state, source-operation tests, current fetcher imports, and zod checks. Add `aiBudget` to the existing UTC imports and `SearchQuery` to current search imports. `paidSearch` reserves and settles real budget; call sites choose an audience. |
| `ai-budget/busy-queue.int.test.ts` | Map legacy `error` to `state = waiting` with `embedding_unavailable`, fixed `retryAt` and retryCount 1. Assert the entire state remains while busy, then ready and retryCount 0. Preserve existing 31-deferral draft recovery. |
| `ai-budget/busy-retries.int.test.ts` | Retain production registry proof. Strengthen the zero-remaining phase to three successive deferrals while held. Wait for the predecessor to complete before reading its successor; assert no additional paid call and unchanged zero limit. Four total failures still give up once. |
| `apps/server/src/jobs.ts` | Keep PR315 send registration as `steps`. The logging wrapper returns the handler result so AI deferrals reach the runner, and still awaits and rethrows errors. |
| `packages/db/src/jobs.ts` | Keep the tenant-only generic runner and removed system-job API. `consume` passes `retryLimit - retryCount`; `work` awaits successor enqueue before settling the predecessor. The transaction branch and last-attempt give-up order remain. |
| `packages/db/src/index.ts` | Add only `JobDeferral` and `hasSearchableKnowledge` to existing exports. Preserve current schema, Actor subpath and export contracts. |
| `packages/db/src/knowledge.int.test.ts`, `leak.int.test.ts` | Apply source test deltas to current integration filenames. Update the knowledge-suite leak pointer to its real filename. Public-only results, preflight, spoofed tenants and filtering before the result limit remain covered. |
| `packages/ai/src/draft-issue.ts` | Paid options wrap generation. Keep PR319 `issueOutputSchema`, its real SDK-schema token bound and max output tokens. |
| `packages/ai/src/embed.ts` | Paid options wrap each batch. Keep PR319 conservative missing, zero and invalid usage charges and failed-batch aggregate accounting. |
| `packages/ai/src/draft-issue.test.ts`, `draft-reply.test.ts`, `embed.test.ts` | Merge paid-factory imports with schema, byte, fixture, and growth imports. Route PR319 captured-schema and silent-batch tests through paid handles without weakening their assertions. |
| `packages/ai/src/evals/task.ts` | Apply isolated paid contexts while preserving the parent's current conversation terminology. These offline contexts do not authorize production calls. |
| `docs/architecture/overview.md` | Describe typed busy deferral and mandatory audience beside the current typed source state and two-phase SMTP flow. Preserve all send-safety paragraphs. |
| `verify-send-reply/SKILL.md`, `EVIDENCE.md` | Retain the prerequisite's two-phase model, lexical selector and known findings. Do not copy the old source coverage table over it. Append source allowance history and selectively update only three actually changed runner fingerprints. |

The remaining source files equal the frozen final source after line-ending normalization, including paid handles and their tests, the full namespace rule and regression fixtures, AI package exports, public DB predicate, budget tests, paid compiler fixture and Biome settings. No optional source cleanup is imported.

## Send-model alignment

PR315's `handleSendReply` remains `Promise<void>` and returns no deferral. Its first transaction commits the prepared outbound row and uncertainty marker. Its second transaction rechecks that marker, calls SMTP, and records success. Therefore the new conditional successor enqueue cannot run for send jobs. Errors still leave the handler through the awaited logging wrapper. `consume` invokes give-up only after handler rollback and only on the last failure, then rethrows for pg-boss settlement. `APP_ENQUEUE_SQL`, queue retry policy and all send/lifecycle bodies remain unchanged.

| Covered function | Prior fingerprint | Integrated fingerprint | Model alignment |
| --- | --- | --- | --- |
| `defineJob` | `a99b2cee9f9e` | `313382219f6f` | Return AI step result, preserve awaited error propagation and give-up wrapper. |
| `createJobRunner.consume` | `246f97b5f432` | `1c5921f6eb32` | Pass remaining failure allowance. Preserve Fail and final-attempt condition. |
| `createJobRunner.work` | `1c138699acca` | `0ac5978b52bb` | AI-only successor branch. Send keeps both committed steps and no successor. |

All other coverage rows match. The targeted fingerprint checks pass. The base model, mutants, checker, expected table, constants, dependency version and configuration generator equal pinned PR315 byte for byte. Reuse its 36 reviewed outcomes and statechart inputs as unchanged model evidence. No blanket confirmation, model-policy change, fresh model-run claim or optional source mutation campaign is made.

Known lost-retry and give-up `NoSilentStall` findings remain unresolved. Busy successors restart exponential backoff from their own first failure. They retain cumulative failures, not backoff position. Successor commit and predecessor settlement are separate; the source review's fault probes do not prove all physical crash histories. Busy deferrals do not waive daily budget checks.

## Verification and publication

The preserved runtime checkpoint is `91620760480544cd7d3a851d5fcfca37c7a549f9`, with `9af285259969c0a28df4cfeb2235e0237e7fb7de` still in its ancestry. Changes after `9af2852` are test strengthening, typed-state fixture mapping, documentation, and fingerprints. No production or type contract changes follow that checkpoint. Dependent #331 may pin `9162076` without importing later evidence-only commits.

The coordinator granted one bounded serial Postgres slot after the other focused runs released their resources. At `9162076`, the server budget, busy-queue, busy-retries, knowledge, draft-knowledge and drafts suites passed all 130 tests across six files in 75.06 seconds. The serial DB knowledge, leak and jobs suites passed all 56 tests across three files in 12.57 seconds. Each command used `--project int --maxWorkers 1` and its own disposable Postgres through the existing global setup. Both processes exited 0 and released their owned resources before requesting the full gate. Logs are `.helpos/328-server-focused.log` and `.helpos/328-db-focused.log`. No production or type fix was needed.

The focused proof covers real pg-boss claims and settlements, 31 busy draft deferrals, typed-state ingestion recovery, and mixed provider failures with three consecutive zero-allowance deferrals. It checks exactly four failed model calls and one give-up. Customer preflight avoids an embedding call for internal-only knowledge, and customer vector retrieval filters public passages before the result limit while retaining tenant isolation. Approver draft context and citations retain internal notes. Eligibility acceleration is test-only; the proof does not claim natural backoff timing, every concurrent crash history, live-model quality, or resolution of the known send stalls.

OpenAPI and dashboard client regeneration produced no diff. Protected PR315 send, lifecycle, Actor, audit, auth, MIME, migration, testing and model/checker files equal the pinned prerequisite. Protected PR319 quote, estimate, fixture and growth files equal that prerequisite. Source accounting contains exactly the prerequisite merge, nine unique source commits, and the integration alignment commit beyond those parents.

No new golden eval input is added because prompts and model output behavior are unchanged. The PR records the proof-check exception explicitly. Existing golden cases still run through the paid eval task; direct paid-handle, captured SDK input, compiler, budget and queue tests prove the changed wiring. This exception is not a live-quality or injection-resistance claim.

Before assembly, the combined prerequisites passed 130 AI tests. After paid-handle integration, 133 AI tests and all 29 compiler/rule checks passed fresh, including the namespace cases and raw-model rejection. Fresh server unit execution passed 416 tests; DB units passed seven. Workspace typechecking passed seven tasks, three fresh and four cached. A temporary compiler fixture rejected three missing and three invalid audiences at DB retrieval, DB preflight and server search, then passed with valid audiences after restoration. The fixture is removed. Two targeted fingerprint regression tests pass without starting TLC.

The throughput boundary is explicit. Offline tests, compiler checks and accounting run during shared work. The coordinator owns allocation of focused Postgres/pg-boss runtime and the one stable full gate. No Docker, browser, model run or full suite starts without its concrete grant. Tests use deterministic providers. No live provider calls, credentials or billable runs are requested. Offline evidence is not live quality or injection-resistance proof. #205 stays deferred.

Deslop found no required cleanup. The one native same-model xhigh Comment Sicko found no required changes, suppressions, or open constraints. All 107 repo script tests passed fresh with no skips; the separate two fingerprint regression tests passed without TLC. Knip and Biome pass. Biome retains the source void-union advisory for compatibility with existing `Promise<void>` handlers, plus the two inherited sync-labels environment warnings. Required before publication are granted focused runtime proof and one stable committed-head `EVAL_LIVE=0 pnpm verify`. The append-only [328-integration.tsv](328-integration.tsv) records assembly decisions and focused proof. The final gate SHA, outcome and fresh/cache split are recorded in the PR and local `.helpos/328-runtime.tsv` without changing the stable tested commit. Fresh independent integration review, hosted CI and human security approval remain coordinator-owned. Retain `needs-human` and `security`; never mark `land`. Originals stay open and untouched. No merge, approval, closure, deletion or settings change is authorized.
