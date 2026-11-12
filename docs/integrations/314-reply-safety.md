# Reply delivery safety and audited lifecycle

This integration finishes the existing reply-safety dependency chain before feature work. People see uncertain delivery and choose whether to confirm it or explicitly send again. Automatic retries cannot start a fresh uncertain attempt. Maintainers inherit typed lifecycle predicates, one MIME composer, and explicit caller audit identity.

## Original base and frozen sources

The original PR315 assembly started at then-current `origin/main`, `8af8f1f3f598b2d4ecfb4a1dcae0222b45f52551`. Main already contains approved [PR310](https://github.com/bsteps/helpos/pull/310). That work is inherited once. The selected linear chain shares base `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` with main.

| Source                                                   | Exact source base                          | Exact frozen head                          | Independent source verdict                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| [PR277, #130](https://github.com/bsteps/helpos/pull/277) | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | `44e45e650181e9ae5c5d5e80c68b407689f78f90` | [Final PASS superseding the earlier ordinary-history FAIL](https://github.com/bsteps/helpos/pull/277#issuecomment-6807632754) |
| [PR292, #195](https://github.com/bsteps/helpos/pull/292) | `44e45e650181e9ae5c5d5e80c68b407689f78f90` | `25231a0014170b5351931239e51d6b842f0a4c0c` | [PASS with notes](https://github.com/bsteps/helpos/pull/292#issuecomment-6808188524)                                          |
| [PR294, #213](https://github.com/bsteps/helpos/pull/294) | `25231a0014170b5351931239e51d6b842f0a4c0c` | `8a18a308dde5bad3a2c5730d687c1bfa47babf50` | [PASS with notes](https://github.com/bsteps/helpos/pull/294#issuecomment-6808922191)                                          |
| [PR298, #193](https://github.com/bsteps/helpos/pull/298) | `8a18a308dde5bad3a2c5730d687c1bfa47babf50` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [PASS with notes](https://github.com/bsteps/helpos/pull/298#issuecomment-6809398812)                                          |
| [PR286, #139](https://github.com/bsteps/helpos/pull/286) | `ba4305a3578297afe727a52eccaa69b4008afdc7` | `388ed1fef08c69fb2ed618bd15a34bf54973e122` | [PASS with notes](https://github.com/bsteps/helpos/pull/286#issuecomment-6807632477)                                          |

All five PRs were OPEN at these exact heads during this task. Originals and discussions remain preserved. Integration trackers, including #314, are outside the original issue denominator.

## Exact commit mapping

Merge `f0e11f21b78ade1901bd15688d87f69d03634246` has parents `8af8f1f3f598b2d4ecfb4a1dcae0222b45f52551` and `0ce9c751b75599d7bd694c59b3efba32547c1cb7`. The complete selected linear range is `git rev-list --reverse 0cb5ba8..0ce9c751`. Each of its 15 source commits retains its exact identity, parent, and content.

| Source | Original commit, also the integration commit | Change                                                    |
| ------ | -------------------------------------------- | --------------------------------------------------------- |
| #130   | `f69980fd6e7ea050b6ff90ea3a30e2c53a5c4844`   | Persist uncertainty before SMTP                           |
| #130   | `32d2520a389c9a55a9b3dfe6ff787a4cef8aab95`   | Durable recovery and crash proof                          |
| #130   | `a1a6b07d92e3c70721129e9c9e6e95c549a898c7`   | Model coverage and Windows mutations                      |
| #130   | `ba4305a3578297afe727a52eccaa69b4008afdc7`   | Verification evidence and remaining findings              |
| #130   | `44e45e650181e9ae5c5d5e80c68b407689f78f90`   | Hide unconfirmed outbound messages from ordinary history  |
| #195   | `9f86eef697b2b9dc27a3c75400ceaf69fb138a99`   | Centralize status predicates                              |
| #195   | `c9ead2d8614f6744f91523224c1d3c8b4e1dc48c`   | Predicate and model coverage                              |
| #195   | `25231a0014170b5351931239e51d6b842f0a4c0c`   | Mutation predicate formatting                             |
| #213   | `af721d4ca624164685df3877b3342ac8b121dc6a`   | One outbound MIME composer                                |
| #213   | `a6e44062b7e1d7de4578de509fca6684d082f177`   | Composer model mapping                                    |
| #213   | `8a18a308dde5bad3a2c5730d687c1bfa47babf50`   | Copy composer into the isolated formal regression fixture |
| #193   | `51285feb9989317edef9dd2dcb7a19f571132210`   | Shared Actor and explicit AuditContext                    |
| #193   | `077f34bb526bcaabb6ed03ac112547f19ce83ca1`   | Select lexical functions for fingerprints                 |
| #193   | `bb78d04e420d5ed3b98eecc16ff4b52414a4097d`   | Confirm reviewed model mapping                            |
| #193   | `0ce9c751b75599d7bd694c59b3efba32547c1cb7`   | Prove covered function-body edits invalidate hashes       |

The unique #139 range is `ba4305a..388ed1f`, exactly one commit and one file. Original `388ed1fef08c69fb2ed618bd15a34bf54973e122` maps to cherry-pick `69b1e999357c5c7ccc7dd92172c6bd46a8ce6486`. Its stable patch ID matches the original. Its obsolete parent is never merged as a replacement tip. The final history includes #130's subsequent ordinary-history fix.

## Necessary parent refresh

The refresh branch `314-migration-refresh` starts at the pinned shared PR313 parent `80e638451a639947fc88cc96af5ee9ef4c73bb7f`. It merges existing PR315 head `54645de0cbe91bbd8d3dd584e9cc0ea714e6a02b`, preserving its merge, all 15 linear source identities, and the exact unique #139 patch. This parent includes actual main `c401a765a80f8e32a16bbdaf03629f20841171dc` with PR311's typed knowledge state. PR313 was independently reviewed at that parent and squash-merged as `58451595845f67aef0fb35e0ba584bac71ad1045`. The squash tree equals the pinned parent tree exactly. Merge `95c41ec8e1bae8bcb1fef284cd19ed6a5989c07e` records the actual main ancestry once and retains the assembled tree without any code delta. PR315 now targets actual main without duplicating parent scope. No source branch is rewritten or pushed.

Integration conflicts require these resolutions.

- Keep PR313's narrowed access union and #193's `isHuman` Actor predicate together. Keep source worker actor exports used by the identity characterization test.
- Keep the parent's typed knowledge ingestion, extracted page fetch and queue operations. Use the shared built-in ingest Actor without restoring its old imports or implementation.
- Keep both schema imports, typed knowledge state and Actor. Retain exact parent migration 0022 and its snapshot. Generate `0023_uncertain-send` from that actual predecessor with Drizzle. The generated SQL only extends draft status and adds the false-default resend marker. The new snapshot links to 0022 and contains both schemas.
- Apply #241's test renames and #200's tenant job-settlement waits. No old filenames, duplicate wait helpers, deferred-work relaxations, or removed system-job API return.
- Derive the exhaustive draft badge status map from public `AnimatedBadgeProps` because the parent removed the unused standalone status type export.
- Preserve #193's corrected lexical selector. Only nested consume/work fingerprints change because the parent removed system-job types, casts and its dead branch. Source-to-model review confirms the live tenant path still parses before work, rolls back before last-attempt give-up, runs two committed send steps, and then settles through pg-boss. Model inputs and all other covered fingerprints stay unchanged. No blanket confirmation is used.

New migration tests begin at the real typed-state predecessor. They pin all existing draft statuses, bodies, Message-IDs, messages and typed waiting knowledge in two tenants, then assert that only the false resend marker is added. They also require transaction and journal rollback if the expanded status constraint fails. Existing migration drift, repeated jobs installation, typed-state translation and rollback assertions remain in place.

## Behavioral and formal contracts

The worker commits a prepared outbound row with `sentAt` null and the draft as `send_uncertain` before SMTP. Its second transaction locks the draft and rechecks status, message row, resend flag, and Message-ID. Successful delivery and a person's explicit confirmation set `sentAt`. Until then the public conversation API and ordinary history exclude the unconfirmed row while the draft retains its body, uncertainty warning, and two decisions.

Lifecycle predicates retain all current statuses, both draft kinds, and the strict approval cutoff. Explicit resolution requires a human with `drafts:approve` and the current Message-ID. Ordinary retry preserves the stored ID. Explicit send-again allocates a new ID. The composer formats IDs and builds MIME without moving approval, marker, SMTP, or settlement boundaries.

Every lifecycle write receives `AuditContext` with tenant, Actor, and request ID. Nested operations record that identity in the same transaction. The already-approved retry audit remains explicit. The remaining non-mutating resend-rejection Auditor call in the worker preserves its attribution. Later work must not restore opaque lifecycle Auditor parameters.

Semantic review maps preparation and its commit to `WorkerLocksAndChecks`, failed preparation to `PreparationFails`, and the second lock and identity check to `WorkerRechecksMarker`. SMTP acceptance, final transaction commit, and pg-boss settlement remain separate. The equality predicates retain the rejection branch's original-draft distinction. Audit identity and MIME bytes are outside the model. The send/lifecycle functions and model files are unchanged from #193. Only the parent runner cleanup needs the two coverage updates described above.

The #193 selector repair is retained. It prefers top-level lexical functions over same-named transition properties. The regression edits every covered function body, including nested `createJobRunner.consume` and `createJobRunner.work`, and checks changed then restored hashes. Earlier hashes for `markSending`, `rejectSend`, `markSent`, and `markSendFailed` selected transition entries and therefore did not protect those function bodies. Earlier runtime and source-mutation evidence remains valid with that historical fingerprint limit.

## Inherited evidence and limits

The linked source verdicts remain evidence for unchanged work, not new integration review. PR277's final verdict proves the repaired ordinary-history filter, with 60 server checks and 11 browser cases. PR292 covers status equivalence, exhaustive dashboard maps, SQL guards, and negative controls. PR294 independently compares all five MIME outputs with the exact pre-extraction parent and committed fixtures, including Unicode, shadow routing, headers, and IDs. Its existing outbound EML fixtures are byte-identical. This integration preserves those fixture blobs and runs their assertions fresh.

PR298 verifies lexical selection against all coverage targets, nested function mutation/restoration, exact user/agent/system audit rows, audit-tenant rollback, and the bounded Mailpit acceptance observation repair. That repair waits for actual acceptance after the uncertainty marker commits. It retains copy-count, COMMIT-failure, physical crash, rejection, give-up, and settlement assertions. None of these accepted fixes is dropped to reduce the diff.

PR286 retains its 45-second persisted-state poll for the exact response draft ID, followed by the real browser badge assertion. Its source receipts include a 33-second worker-delay pass, a 50-second stall failure, and a stale-browser failure. These receipts are reused for the unchanged helper and server timing. They do not establish the historical host-overload cause or protection against arbitrary starvation.

The 36 frozen #193 statechart reports remain at `E:/Projects/helpdesk/.helpos/autopilot/193-statechart-frozen/results.json`. Fresh integration TLC inputs match all 36 frozen model/config pairs byte for byte. The reports contain 24 holds and 12 expected known or mutant breaks. No redundant statechart generation or rendering is performed.

The known lost-retry and give-up `NoSilentStall` findings remain OPEN. Old-job settlement can strand a newly approved retry. Last-attempt worker death or a failed give-up transaction can also strand approval. A successful runner exit reproduces those expected findings, rather than proving every promise. Bounds remain one draft, two workers, one automatic retry, one person retry, and one selected fault. The model does not prove all eight production retries, arbitrary job generations, audit identity, HTTP permission checks, tenant isolation, shadow routing, or live AI quality.

## Migration and later dependencies

PR311 has landed in actual main. Its `0022_typed-knowledge-state` is preserved byte for byte. Source #130's original `0022_uncertain-send` remains in source history, while the current combined tree replaces it with generated `0023_uncertain-send`. The next snapshot is generated against the actual 0022 snapshot, not renamed from the contradictory old snapshot.

PR313 supplies the following concrete path and wait contracts.

| Current path                                           | Destination after #241 / PR313                             |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `apps/server/src/app.test.ts`                          | `apps/server/src/app.int.test.ts`                          |
| `apps/server/src/inbound-email/route.test.ts`          | `apps/server/src/inbound-email/route.int.test.ts`          |
| `apps/server/src/workspaces/init-workspace.test.ts`    | `apps/server/src/workspaces/init-workspace.int.test.ts`    |
| `packages/db/src/auth.test.ts`                         | `packages/db/src/auth.int.test.ts`                         |
| `packages/db/src/client.test.ts`                       | `packages/db/src/client.int.test.ts`                       |
| `packages/db/src/jobs.test.ts`                         | `packages/db/src/jobs.int.test.ts`                         |
| `packages/db/src/leak.test.ts`                         | `packages/db/src/leak.int.test.ts`                         |
| `packages/db/src/migrate-conversation-scopes.test.ts`  | `packages/db/src/migrate-conversation-scopes.int.test.ts`  |
| `packages/db/src/migrate-unique-knowledge-url.test.ts` | `packages/db/src/migrate-unique-knowledge-url.int.test.ts` |
| `packages/db/src/schema.test.ts`                       | `packages/db/src/schema.int.test.ts`                       |
| `apps/server/src/knowledge/knowledge.test.ts`          | `apps/server/src/knowledge/knowledge.int.test.ts`          |
| `packages/db/src/knowledge.test.ts`                    | `packages/db/src/knowledge.int.test.ts`                    |
| `apps/server/src/drafts/drafts.test.ts`                | `apps/server/src/drafts/drafts.int.test.ts`                |
| `packages/db/src/migrations.test.ts`                   | `packages/db/src/migrations.int.test.ts`                   |

#200 maps the draft and knowledge edits to those destinations. `notice-worker.int.test.ts`, `send-failed.int.test.ts`, `send-invariants.int.test.ts`, `send-path-replay.int.test.ts`, and `github.int.test.ts` keep their paths. Preserve its observable tenant job-settlement waits and deferred-work rejection while adding this chain's assertions. Original maps are at `E:/Projects/helpdesk/.helpos/autopilot/241-rename-map.tsv` and `200-test-path-mapping.tsv`.

| Excluded source                                                                                                                                                                                              | Required later port                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PR208](https://github.com/bsteps/helpos/pull/208)                                                                                                                                                           | Port send-test calls from a transaction to `db.withTenant.bind(db, tenantId)` for the two-phase worker.                                                         |
| [PR283](https://github.com/bsteps/helpos/pull/283)                                                                                                                                                           | Keep #195's exhaustive status map in the extracted `conversation-drafts.tsx`. `meanwhileByStatus` remains in `draft-view.ts`.                                   |
| [PR203](https://github.com/bsteps/helpos/pull/203)                                                                                                                                                           | Reconcile its busy-deferral wrapper with observable model actions and commit boundaries.                                                                        |
| [PR194](https://github.com/bsteps/helpos/pull/194), [PR240](https://github.com/bsteps/helpos/pull/240), [PR85](https://github.com/bsteps/helpos/pull/85), [PR242](https://github.com/bsteps/helpos/pull/242) | Preserve this Actor/AuditContext boundary in GitHub, conversation-writer, typed-audit-detail, and regeneration callers. Never restore opaque lifecycle Auditor. |

## Prior combined proof and inherited limits

The original PR315 head passed 263 focused server tests in 13 files. They use real isolated Postgres, pg-boss, and Mailpit where required. They cover uncertain SMTP with no automatic fresh attempt, actual COMMIT failure and physical worker death, lifecycle predicates, exact audit identity, scope and tenant denial, rollback, fixtures, and headers.

At the original PR315 head, `pnpm verify:send-reply` matched all 36 expected outcomes and coverage fingerprints. `pnpm verify:send-reply:mutations` passes all eight baseline and restored assertions. All four source mutations fail their five intended assertions. Source restoration is byte-for-byte. No other tests or source edits run during those mutations.

The original PR315 Playwright execution passed 22 laptop/phone cases with one existing viewport skip across inbox, failed-send recovery, and uncertain-send resolution. It checks the public API history, real page history, retained draft warning and choices, and exact shadow-recipient copy counts. Two temporary laptop controls fail at the intended assertions. Expecting sent for an actually failed draft times out at the 45-second persisted-state predicate with the exact draft ID. Serving stale approved state only to browser requests lets that predicate pass but fails the retained Not sent badge assertion at 15 seconds. The temporary test file is removed. The unmodified source suites already passed, and their bytes remain unchanged.

At the original PR315 head, `pnpm test:scripts` passed all 103 tests with no skips. The covered-function body regression includes all previously missed functions and nested consume/work. All transient fixtures are finished and removed before the stable committed head receives one complete `pnpm verify`. The replacement PR and decision trail record its exact SHA, fresh/cache counts, browser checks, tooling results, migration result, and limitations. This ordering avoids Knip observing scratch fixtures. No redundant full-suite rerun is required without invalidation.

Deslop and the single native Comment Sicko review find no required changes. Comment review reports zero deletions, restored comments, reruns, suppressions, or open constraints. Technical-writing and unslop guide this reference and the PR body. Local security, tenant-isolation, and test-signal inspection found no new finding. This is implementation-side review, not root's later fresh independent integration review or human security approval.

Codex `gpt-6.1-sol` with xhigh reasoning prepares this integration. Original source provenance remains in the linked verdicts. Fresh independent integration review of the refreshed combination, current-head hosted CI, and human security approval remain required. Keep `pr:in-progress` and `needs-human`, never `land`. No merge, approval, closure, branch deletion, source push, or settings change is authorized.

#205 is deferred. No credentials, paid evals, provider accounts, live Anthropic, or other live provider calls are used. Deterministic browser and offline checks prove machinery, prompt transport, and assertions. They do not prove live model quality or injection resistance. There is no new dependency, feature, or suppression.

The decision trail is `E:/Projects/helpdesk/.helpos/autopilot/314-integration.tsv`. Tests own their disposable databases and processes. Shared `.env` bytes and running Docker remain preserved.

## Refresh validation

Offline Drizzle generation produced migration 0023 against the exact typed-state predecessor. Focused unit checks passed 26 lifecycle/MIME/identity, 152 access/route/job, 5 Actor, and 22 dashboard assertions. Typecheck passed all seven packages after the badge import reconciliation, with three fresh tasks and four cached tasks. The first dashboard command used the server-only unit project name and stopped before tests; rerunning with its existing configuration passed.

The parent activated the exclusive heavy slot after confirming PR313 merged. Refreshed evidence is recorded below. Unchanged source reviews and 36 frozen statechart reports remain inherited evidence.

### Source overlap accounting

After the documented draft test rename, 51 of the 73 linear-chain paths still match #193 byte for byte. The 22 overlaps are explicit.

| Paths                                                                                             | Combined-tree reason                                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `verify-send-reply/EVIDENCE.md`, `verify-send-reply/SKILL.md`                                     | Parent test-path references and reviewed nested runner fingerprints.                                       |
| `auth/access.ts`                                                                                  | Narrowed access union plus shared Actor predicate.                                                         |
| `drafts/draft-worker.ts`                                                                          | Parent unused knowledge-limit export deletion plus source worker Actor.                                    |
| `drafts/drafts.int.test.ts`, `drafts/notice-worker.int.test.ts`, `drafts/send-failed.int.test.ts` | Source lifecycle assertions plus parent job-settlement waits and test rename.                              |
| `knowledge/ingest-worker.ts`                                                                      | Parent typed-state/extraction operations plus source Actor.                                                |
| `outbound-email/shadow.ts`, `tokens/routes.ts`                                                    | Parent removes unused exports; source Actor imports and MIME ID helper remain.                             |
| `apps/web/e2e/send-failed.spec.ts`                                                                | Existing unique #139 patch, unchanged from PR315.                                                          |
| `apps/web/src/api/openapi.json`, `apps/web/src/api/schema.gen.ts`                                 | Typed knowledge API plus uncertain-send API metadata.                                                      |
| `apps/web/src/routes/conversation.tsx`                                                            | Source exhaustive status map derives the parent public badge props.                                        |
| `docs/architecture/overview.md`, `docs/security/threat-model.md`                                  | Both knowledge-state and reply-safety descriptions.                                                        |
| Original `0022_uncertain-send.sql`, `meta/0022_snapshot.json`, `meta/_journal.json`               | Preserve parent 0022, replace uncertain-send in the tree with generated 0023 and append its journal entry. |
| `packages/db/package.json`                                                                        | Source Actor export plus parent unit/integration project command.                                          |
| `packages/db/src/schema.ts`                                                                       | Both typed-state and Actor/draft schema additions.                                                         |
| `packages/db/src/testing.ts`                                                                      | Parent observable worker waits plus source uncertain-draft leak fixture.                                   |

The shared `.env` SHA-256 at refresh start is `604264a8e6a93210d1899d0a0c9a028c0df589ed47290353b81cd4b67267c1d1`. This checkout setup copied those bytes into its own environment file. No shared environment write is needed.

### Fresh checks after the actual parent merge

The DB focused run passed 35 assertions and exposed one defect in the new rollback fixture. Removing the old constraint made migration fail before its additive work. Restoring that constraint as NOT VALID allows deliberately invalid legacy data, so the assertion now proves failure at the new status constraint. The corrected two-test predecessor/data/rollback run passes. Existing typed-state translation and rollback, schema/RLS, job integration, drift detection, and repeated migration/job installation assertions passed unchanged.

The send-focused run passed 98 integration assertions in eight files against real Postgres, pg-boss and Mailpit. It includes uncertain acceptance, COMMIT failure, physical worker death, no fresh automatic attempt, exact audit identity, audit-tenant rollback, cross-tenant denial, lifecycle predicates, headers and fixture bytes.

`pnpm verify:send-reply` matched all 36 expected outcomes and selectively maintained fingerprints. All 36 freshly generated model/config pairs equal #193 frozen inputs byte for byte. The 24 holds and 12 expected known/mutant breaks retain their reviewed statechart explanations without rendering again. `pnpm verify:send-reply:mutations` passed both eight-assertion baseline/restored runs, rejected all four source mutations at their five intended assertions, and restored both covered source files byte for byte.

The refreshed browser run passed 22 laptop/phone cases with one existing viewport skip across inbox, failed-send and uncertain-send recovery. Both temporary negative controls failed at their intended assertions. A wrong sent-status expectation fails the 45-second persisted-state predicate for the exact response draft. A browser-only stale approved response allows the API predicate to pass and fails the retained Not sent badge assertion. The temporary test is removed. OpenAPI regeneration produces no metadata diff.

The fresh native Comment Sicko review covers only integration-authored changes, with zero new comments, suppressions, deletions or open constraints. Deslop keeps only necessary parent conflicts, generated metadata, characterization tests and provenance. Root owns the later independent combined review.

The full publication gate runs once on the final stable committed head after scratch fixtures finish. Its exact SHA, result and fresh/cache split are recorded in the append-only decision trail and PR evidence. Previous full-gate receipts remain historical, not a claim about this refreshed head. Shared Docker is preserved; test-owned databases, containers and processes are cleaned up by their harnesses.

`pnpm test:scripts` passed all 107 tests with no skips after browser and source mutation restoration. This includes corrected lexical/nested fingerprint invalidation, model negative controls, filename and Knip fixtures. No scratch test remains before the full gate.
