# Reply delivery safety and audited lifecycle

This integration finishes the existing reply-safety dependency chain before feature work. People see uncertain delivery and choose whether to confirm it or explicitly send again. Automatic retries cannot start a fresh uncertain attempt. Maintainers inherit typed lifecycle predicates, one MIME composer, and explicit caller audit identity.

## Actual base and frozen sources

`314-reply-safety` starts at actual `origin/main`, `8af8f1f3f598b2d4ecfb4a1dcae0222b45f52551`. Main already contains approved [PR310](https://github.com/bsteps/helpos/pull/310). That work is inherited once. The selected linear chain shares base `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` with main.

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

## Conflicts and integration-specific edits

There were no merge or cherry-pick conflicts against actual main. No production, fixture, model, or fingerprint integration edit was needed. This manifest is the only new integration document. All 72 source-chain files other than `apps/web/e2e/send-failed.spec.ts` match the #193 tip by Git blob. That test retains the chain's changed badge text and only adds #139's exact patch. Every file changed by PR310 matches actual main by Git blob.

The rerunnable local comparison `.helpos/prove-314.mjs` checks ancestry, source blobs, main blobs, the wait patch, and all frozen model/config pairs. `.helpos/314-equivalence.json` records the result. These are evidence artifacts, not additional product architecture.

## Behavioral and formal contracts

The worker commits a prepared outbound row with `sentAt` null and the draft as `send_uncertain` before SMTP. Its second transaction locks the draft and rechecks status, message row, resend flag, and Message-ID. Successful delivery and a person's explicit confirmation set `sentAt`. Until then the public conversation API and ordinary history exclude the unconfirmed row while the draft retains its body, uncertainty warning, and two decisions.

Lifecycle predicates retain all current statuses, both draft kinds, and the strict approval cutoff. Explicit resolution requires a human with `drafts:approve` and the current Message-ID. Ordinary retry preserves the stored ID. Explicit send-again allocates a new ID. The composer formats IDs and builds MIME without moving approval, marker, SMTP, or settlement boundaries.

Every lifecycle write receives `AuditContext` with tenant, Actor, and request ID. Nested operations record that identity in the same transaction. The already-approved retry audit remains explicit. The remaining non-mutating resend-rejection Auditor call in the worker preserves its attribution. Later work must not restore opaque lifecycle Auditor parameters.

Semantic review maps preparation and its commit to `WorkerLocksAndChecks`, failed preparation to `PreparationFails`, and the second lock and identity check to `WorkerRechecksMarker`. SMTP acceptance, final transaction commit, and pg-boss settlement remain separate. The equality predicates retain the rejection branch's original-draft distinction. Audit identity and MIME bytes are outside the model. These covered functions and model files are unchanged from #193, so no `--confirm` or model edit is appropriate.

The #193 selector repair is retained. It prefers top-level lexical functions over same-named transition properties. The regression edits every covered function body, including nested `createJobRunner.consume` and `createJobRunner.work`, and checks changed then restored hashes. Earlier hashes for `markSending`, `rejectSend`, `markSent`, and `markSendFailed` selected transition entries and therefore did not protect those function bodies. Earlier runtime and source-mutation evidence remains valid with that historical fingerprint limit.

## Inherited evidence and limits

The linked source verdicts remain evidence for unchanged work, not new integration review. PR277's final verdict proves the repaired ordinary-history filter, with 60 server checks and 11 browser cases. PR292 covers status equivalence, exhaustive dashboard maps, SQL guards, and negative controls. PR294 independently compares all five MIME outputs with the exact pre-extraction parent and committed fixtures, including Unicode, shadow routing, headers, and IDs. Its existing outbound EML fixtures are byte-identical. This integration preserves those fixture blobs and runs their assertions fresh.

PR298 verifies lexical selection against all coverage targets, nested function mutation/restoration, exact user/agent/system audit rows, audit-tenant rollback, and the bounded Mailpit acceptance observation repair. That repair waits for actual acceptance after the uncertainty marker commits. It retains copy-count, COMMIT-failure, physical crash, rejection, give-up, and settlement assertions. None of these accepted fixes is dropped to reduce the diff.

PR286 retains its 45-second persisted-state poll for the exact response draft ID, followed by the real browser badge assertion. Its source receipts include a 33-second worker-delay pass, a 50-second stall failure, and a stale-browser failure. These receipts are reused for the unchanged helper and server timing. They do not establish the historical host-overload cause or protection against arbitrary starvation.

The 36 frozen #193 statechart reports remain at `E:/Projects/helpdesk/.helpos/autopilot/193-statechart-frozen/results.json`. Fresh integration TLC inputs match all 36 frozen model/config pairs byte for byte. The reports contain 24 holds and 12 expected known or mutant breaks. No redundant statechart generation or rendering is performed.

The known lost-retry and give-up `NoSilentStall` findings remain OPEN. Old-job settlement can strand a newly approved retry. Last-attempt worker death or a failed give-up transaction can also strand approval. A successful runner exit reproduces those expected findings, rather than proving every promise. Bounds remain one draft, two workers, one automatic retry, one person retry, and one selected fault. The model does not prove all eight production retries, arbitrary job generations, audit identity, HTTP permission checks, tenant isolation, shadow routing, or live AI quality.

## Migration and later dependencies

At assembly, PR311 is OPEN at `cada3c578a45695697f573ee7a5ef07db573ab83`, awaiting explicit human approval. Its sources are excluded. Actual main has no migration 0022. This branch therefore retains source #130's `0022_uncertain-send.sql`, journal entry, and snapshot without speculative renumbering. It adds `resend_requested` with a false default and extends the status CHECK without deleting data. A later actual merge of PR311 requires combining both schemas and regenerating the next migration/journal/snapshot from its actual predecessor. Its separate `0022_typed-knowledge-state` must survive. The final pre-gate fetch still resolves origin/main to `8af8f1f3f598b2d4ecfb4a1dcae0222b45f52551`; PR311 remains OPEN at the same head. No numbering collision exists on actual main, so no migration is renumbered.

The final pre-gate check also confirms PR313 remains OPEN at `acdd2f60f0d04ea4b86577d42bb0da9806d30196`, and excluded. Apply the concrete maps below if it actually lands. Do not create future stub files or restore old test names or waits.

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

## Fresh combined proof and handoff

Fresh focused server checks pass 263 tests in 13 files. They use real isolated Postgres, pg-boss, and Mailpit where required. They cover uncertain SMTP with no automatic fresh attempt, actual COMMIT failure and physical worker death, lifecycle predicates, exact audit identity, scope and tenant denial, rollback, fixtures, and headers.

`pnpm verify:send-reply` matches all 36 expected outcomes and coverage fingerprints. `pnpm verify:send-reply:mutations` passes all eight baseline and restored assertions. All four source mutations fail their five intended assertions. Source restoration is byte-for-byte. No other tests or source edits run during those mutations.

Fresh Playwright execution passes 22 laptop/phone cases with one existing viewport skip across inbox, failed-send recovery, and uncertain-send resolution. It checks the public API history, real page history, retained draft warning and choices, and exact shadow-recipient copy counts. Two temporary laptop controls fail at the intended assertions. Expecting sent for an actually failed draft times out at the 45-second persisted-state predicate with the exact draft ID. Serving stale approved state only to browser requests lets that predicate pass but fails the retained Not sent badge assertion at 15 seconds. The temporary test file is removed. The unmodified source suites already passed, and their bytes remain unchanged.

`pnpm test:scripts` passes all 103 tests with no skips. The covered-function body regression includes all previously missed functions and nested consume/work. All transient fixtures are finished and removed before the stable committed head receives one complete `pnpm verify`. The replacement PR and decision trail record its exact SHA, fresh/cache counts, browser checks, tooling results, migration result, and limitations. This ordering avoids Knip observing scratch fixtures. No redundant full-suite rerun is required without invalidation.

Deslop and the single native Comment Sicko review find no required changes. Comment review reports zero deletions, restored comments, reruns, suppressions, or open constraints. Technical-writing and unslop guide this reference and the PR body. Local security, tenant-isolation, and test-signal inspection found no new finding. This is implementation-side review, not root's later fresh independent integration review or human security approval.

Codex `gpt-6.1-sol` with xhigh reasoning prepares this integration. Original source provenance remains in the linked verdicts. Fresh independent integration review, current-head hosted CI, and human security approval remain required. Keep `pr:in-progress` and `needs-human`, never `land`. No merge, approval, closure, branch deletion, source push, or settings change is authorized.

#205 is deferred. No credentials, paid evals, provider accounts, live Anthropic, or other live provider calls are used. Deterministic browser and offline checks prove machinery, prompt transport, and assertions. They do not prove live model quality or injection resistance. There is no new dependency, feature, or suppression.

The decision trail is `E:/Projects/helpdesk/.helpos/autopilot/314-integration.tsv`. Tests own their disposable databases and processes. Shared `.env` bytes and running Docker remain preserved.
