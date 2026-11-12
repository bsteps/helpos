# Auditable operations integration

## Scope and prerequisites

Domain operations own conversation and message writes and truthful structured audit events under each route's declared caller policy. Demo histories follow the draft lifecycle.

The integration starts at PR315 `80d10689dc1fe917c8f6364d5015edee9b7ad90e` and targets `314-reply-safety`. This is the frozen parent, even if that branch later moves. Landed knowledge ingestion 0022 and uncertain-send 0023 remain intact. The inherited #193 Actor/AuditContext contract, lexical fingerprint selector, two-phase SMTP boundary, hidden unconfirmed messages, stable Message-ID and MIME composition remain prerequisites.

Only #194, #240, #197, #242, #85 and #247 are selected. Groups #326, #327 and #328 do not overlap this selection. API conventions/codegen PR305 through PR309 and typed-enum PR284 remain unassigned later groups. Later #10 idempotency SQL was numbered 0023 in its source. Its integration must allocate the next index after this dependency, regenerate against the actual schema, and record the collision. It is not included here.

## Frozen source accounting

The unique source delta is the declared PR base to its exact head. The final column links existing independent evidence, not a repeated review. Each merge base below is computed against the frozen integration parent.

| Original issue and PR                                                                                    | Frozen head                                | Unique-delta parent                        | Merge base with PR315                      | Inherited proof                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [#194](https://github.com/bsteps/helpos/issues/194) / [PR299](https://github.com/bsteps/helpos/pull/299) | `1d797e13b58a2bdebc41cd772abf0f292cc38739` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [Independent source verdict](https://github.com/bsteps/helpos/pull/299#issuecomment-6809594322) |
| [#240](https://github.com/bsteps/helpos/issues/240) / [PR300](https://github.com/bsteps/helpos/pull/300) | `15aba333edb5669a0babdab56b4d11c3e5b628ff` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [Independent source verdict](https://github.com/bsteps/helpos/pull/300#issuecomment-6809784417) |
| [#197](https://github.com/bsteps/helpos/issues/197) / [PR301](https://github.com/bsteps/helpos/pull/301) | `c44af156505c9f018d175f8d1845ee0286aa5e23` | `1d797e13b58a2bdebc41cd772abf0f292cc38739` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [Independent source verdict](https://github.com/bsteps/helpos/pull/301#issuecomment-6810004589) |
| [#242](https://github.com/bsteps/helpos/issues/242) / [PR302](https://github.com/bsteps/helpos/pull/302) | `5f68034011bcb3dc5a67cc9c95e76bef8ae2250c` | `15aba333edb5669a0babdab56b4d11c3e5b628ff` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [Independent source verdict](https://github.com/bsteps/helpos/pull/302#issuecomment-6810071124) |
| [#85](https://github.com/bsteps/helpos/issues/85) / [PR303](https://github.com/bsteps/helpos/pull/303)   | `f770abf42d6415cb15862cd368e8d6df003869e5` | `15aba333edb5669a0babdab56b4d11c3e5b628ff` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [Independent source verdict](https://github.com/bsteps/helpos/pull/303#issuecomment-6810205143) |
| [#247](https://github.com/bsteps/helpos/issues/247) / [PR304](https://github.com/bsteps/helpos/pull/304) | `bbea29ae52be638cb0748089069ec847f69d0dbe` | `5f68034011bcb3dc5a67cc9c95e76bef8ae2250c` | `0ce9c751b75599d7bd694c59b3efba32547c1cb7` | [Independent source verdict](https://github.com/bsteps/helpos/pull/304#issuecomment-6810259704) |

The source chains overlap. #197 inherits #194, #242 and #85 inherit #240, and #247 inherits #242. Their prerequisites were applied once, never replayed as stale ancestor chains. Source #193 is already integrated by PR315 and is not counted as a selected source.

## Applied commits

Each source commit retains its original author and authored date. `cherry-pick -x` records the original commit in every port. Integration-only work follows these source commits.

| Issue | Original commit                            | Applied commit                             | Change                                                              |
| ----- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------- |
| #194  | `18c2db8a27b6221271500fcec41f01201ad381ae` | `c8f2f5bde5e2f90a2710fbe3d594973b4a4000f2` | test(github): reproduce request and recheck audit attribution       |
| #194  | `1d797e13b58a2bdebc41cd772abf0f292cc38739` | `595a02b62621a169b48a3a7bb967cb830017d427` | fix(github): attribute issue changes to requests and recheck jobs   |
| #240  | `08a159c5a71a0ad1d0d2a6c96d9eca426dd3a138` | `0b5bff8d0fe751f08f42d3cc44dc46ee3299991f` | refactor(conversations): centralize conversation and message writes |
| #240  | `1844b46e1b30b5d1a8a874b1e8ddc4e7ba9d9c86` | `f82d36512d86dcdc83912a05690fd7cbff721779` | test(conversations): track extracted send writes in formal coverage |
| #240  | `15aba333edb5669a0babdab56b4d11c3e5b628ff` | `24a062f10b7fd312700b09eb49ca0d0d024a3664` | docs(conversations): record enforced write ownership                |
| #197  | `c44af156505c9f018d175f8d1845ee0286aa5e23` | `074a6d804a224d52e259dd119c479c7e3e4f234f` | test(auth): enforce reviewed route access and audit rules           |
| #242  | `5f68034011bcb3dc5a67cc9c95e76bef8ae2250c` | `950ff46eb3816e6770566b89fd89b4e0b652e175` | refactor(drafts): extract the regenerate operation                  |
| #85   | `6b9190b477398518fd6502545489b7937a16f7e1` | `9e5257094ff89a16ea74a1ce7f41910b59bb2385` | feat(audit): record validated draft inputs and discard reasons      |
| #85   | `c030a59746bb31a71efc76cd3bcfab684a25ce6a` | `4e6176571490f1effc815eb7bafd93c16e860e05` | test(audit): confirm reviewed send-path coverage                    |
| #85   | `f770abf42d6415cb15862cd368e8d6df003869e5` | `c6d4605067766d94eb29f95fcb8288ae3fe18fcf` | test(audit): expect validated empty details on other actions        |
| #247  | `b00ad649f8b8f78f3847a724af487137ee8f1dbf` | `5aabc338a1d02ea633a58d6380b6c19c9f634c83` | test(seed): pin demo draft lifecycle invariants                     |
| #247  | `bbea29ae52be638cb0748089069ec847f69d0dbe` | `2ece16bc4b6171fcaa2681013d3f655a377133a4` | fix(seed): complete demo draft lifecycle history                    |

## Actual integration ports

- #240's seed import keeps the landed `queueIngest` source operation and moves conversation/message insertion to `seedConversationHistory`. It does not restore the stale direct enqueue import.
- #197's three AGENTS enforcement rows coexist with #240's ownership row and the parent's actual `*.int.test.ts` references. The human shadow fixture and its user-attributed audit expectation are ported only to `drafts/drafts.int.test.ts`. The parent's #241 test partition and #200 worker waits stay in place.
- `Access` retains Actor-based human checks and adds the accepted `selfOrAdmin` variant. Only `DELETE /v1/tokens/{id}` uses that variant. Human-only workspace admin, exact caller/audit exceptions and method/resource scope checks remain bounded to #197's declarations. No scope is added.
- #85's HTTP regenerate branch is not restored. `regenerateDraft` owns conversation locking, latest human message selection, live-reply check, closed/budget refusal, manual/regenerate discard details, clearing only `draft_failed`, and singleton enqueue in that order. Its queued result keeps `discardedDraftIds`. The adapter calls `nothingToAudit` only when queued with no discarded drafts.
- Creation, edit, approval and discard audits retain their supplied AuditContext. Same-message replacement reports manual/regenerate, rather than claiming a newer inbound message. New-message replacement carries its actual `newerMessageId`. Issue reopen carries `issue_reopened`.
- The source audit-details 0023 conflicts with PR315's uncertain-send 0023. The source SQL/snapshot/journal entry were excluded. `pnpm --filter @helpos/db generate --name audit-details` generated `0024_audit-details.sql` and its snapshot against the actual combined schema. The only SQL is `ALTER TABLE "audit_events" ADD COLUMN "details" jsonb;`. Parent 0022/0023 snapshots and SQL stay byte-identical. A second generation reports no schema changes.
- #247's 35 seed audit rows store 31 available details objects and four unavailable histories. The creation before two edits, both intermediate edits and the discard reason remain NULL. Existing scenario content, IDs, token credentials, jitter and message chronology are preserved. Exact final-body approval hashes and actual send transitions are available. These synthetic system/seed events do not claim a live approval or SMTP delivery occurred.

No dependency, table, scope, suppression, or policy extension outside the accepted #85/#197 deltas is introduced. SHA-256 allows exact-body comparison. It does not anonymize guessable text, and this integration adds no masking or retention policy.

## Selective semantic coverage

The #240 coverage rows for `addMessage`, `markMessageSent`, `recordActivity` and `removeRejectedMessage` travel with their extracted writes. The #85 hashes for `handleSendReply`, `change`, `changeDetails` and `retrySend` travel with the validated audit changes. All current coverage rows match the lexical fingerprint extractor after integration. Parent nested runner hashes remain untouched. No blanket `--confirm` or formal rerun is used for unchanged correspondence.

The known lost-retry and failed-give-up `NoSilentStall` findings remain OPEN. Existing bounded formal success reproduces these findings and is not a claim that every property holds. Bounds remain one draft, two workers, one automatic retry, one person retry and the configured fault scenario. The model omits audit contents, HTTP authorization and live provider quality.

## Verification and limits

Inherited independent evidence is linked per exact source head above and in `314-reply-safety.md`. Advisory jobs whose comments say they did not finish are not completed reviews. Unchanged browser, send crash, Mailpit, source mutation and formal evidence is reused with its original limits.

Fresh light checks pass. All seven package typechecks pass, with three executed and four cache hits. The initial seven-file unit selection passes 273 tests. Seed compatibility adds one passing test and the two-file seed selection passes 31 tests. The first new seed inventory expectation listed the four unknown actions in the wrong order; the expectation was corrected to the existing scenario order without changing seed output. API regeneration leaves the accepted document and generated types unchanged. The 30 ownership and integration-filename tooling tests pass. The covered-function edit regression passes and restores every fixture. Knip and Biome pass, with only two existing environment-variable warnings.

The seed equivalence probe compares the actual builder with frozen #247 and PR315. All values match #247 apart from the accepted details. Against PR315, all values match apart from accepted draft `updatedAt`, 24 added lifecycle events and details. All 12 original/applied commit receipts preserve authors and authored dates. The generated 0024 snapshot differs from 0023 only by its IDs and `audit_events.details`; journal entries through 0023 and both parent SQL/snapshot pairs are unchanged.

One same-model gpt-6.1-sol xhigh Comment Sicko/deslop review found one private implementation comment to delete and no substantive code slop. That comment was deleted. Public access-contract comments remain. No suppressions, application-code rewrites or extra reviewers were introduced by this pass.

The root granted bounded PG-only runtime with `maxWorkers=1`. Seven affected files passed 118 tests covering stored audit details, real session/token route authentication, regenerate and conversation writes, Actor attribution, domain rollback and combined seed insertion/reruns. The initial eight-file run passed 120 of 121 tests. Only the new migration fixture failed, first because a prepared `SELECT *` changed its result shape across ALTER, then because a raw insert omitted its client-generated ID. The fixture uses a separate qualified projection and supplies its ID. A focused corrected migration run passes all three checks, including schema generation no-op, legacy data preservation/NULL compatibility, DDL and write rollback, and migration/job catalog idempotence. The failed fixture attempts are retained rather than counted as passing proof.

Evidence is in this checkout under `.helpos/329/`, including `focused-pg.log`, `migration-pg-corrected.log`, `migration-pg-final.log`, `seed-equivalence.json`, `accounting.json`, `fingerprints.log` and the light-check logs. Owned test containers and connections exited; shared Docker and `.env` bytes remain untouched.

One stable full gate still requires its separate root grant. The root owns a fresh independent integration review. No browser, Docker, formal or full run starts without its concrete grant. Live providers and #205 quality remain deferred; deterministic API proof does not establish live AI quality.
