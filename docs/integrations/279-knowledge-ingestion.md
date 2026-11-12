# Knowledge ingestion integration

## Included sources

Tracking issue [#279](https://github.com/bsteps/helpos/issues/279) combines the approved knowledge cleanup before feature work.
The branch starts at fetched `origin/main`, `0cb5ba823f010b8fb0ec7ac6061faeb673d31658`.
Its source commits form a linear chain from that base. A fast-forward preserves all five commits without replaying ancestors.

| Source                                             | Covered issue                                       | Exact source head and actual parent base                                                 | Independent source review                                                                      |
| -------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [PR253](https://github.com/bsteps/helpos/pull/253) | [#246](https://github.com/bsteps/helpos/issues/246) | `5df0c2bacc77eafa8d2e23debbd4ccaf199d75df` on `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | [Page-fetch verdict](https://github.com/bsteps/helpos/pull/253#issuecomment-6806743003)        |
| [PR272](https://github.com/bsteps/helpos/pull/272) | [#214](https://github.com/bsteps/helpos/issues/214) | `986a1134b36df598b00bb34eb076d18f31a12461` on `5df0c2bacc77eafa8d2e23debbd4ccaf199d75df` | [Typed-state verdict](https://github.com/bsteps/helpos/pull/272#issuecomment-6807087304)       |
| [PR275](https://github.com/bsteps/helpos/pull/275) | [#202](https://github.com/bsteps/helpos/issues/202) | `20c5ee3fa6470548d4bd34600ecf13d30981638c` on `986a1134b36df598b00bb34eb076d18f31a12461` | [Source-operations verdict](https://github.com/bsteps/helpos/pull/275#issuecomment-6807178735) |

All three PRs were OPEN at assembly, with the exact pinned heads and bases above.
Their branches, bodies, labels, and discussions remain unchanged.
The replacement closes #246, #214, #202, and #279 only on a later authorized merge.

Each unique source commit maps to the identical integration commit.

| Source commit                              | Integration commit                         | Change                                     |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| `72fc63e215953ff84aceb776857e2e67ffadc721` | `72fc63e215953ff84aceb776857e2e67ffadc721` | Extract page fetch and decoding            |
| `5df0c2bacc77eafa8d2e23debbd4ccaf199d75df` | `5df0c2bacc77eafa8d2e23debbd4ccaf199d75df` | Prove meta charset selection               |
| `986a1134b36df598b00bb34eb076d18f31a12461` | `986a1134b36df598b00bb34eb076d18f31a12461` | Model source state and retry allowance     |
| `eb2660460058f039bc91d1f6b81a2c65d9780c01` | `eb2660460058f039bc91d1f6b81a2c65d9780c01` | Extract source operations and ingest queue |
| `20c5ee3fa6470548d4bd34600ecf13d30981638c` | `20c5ee3fa6470548d4bd34600ecf13d30981638c` | Remove redundant operation comments        |

## Integration edits

There are no assembly conflicts or application changes. The source tree initially equals PR275's pinned head exactly.
This manifest records the integration separately from the preserved source commits.
The deslop pass retains the bounded source implementation rather than adding optional cleanup.

The contract is the existing source, API, and browser test set.
Page fetching owns fetch limits, content types, decoding, and text extraction.
The worker owns retries and stale-request fencing. Source operations own transactional writes and audit records.
Routes, worker, and seed use `queueIngest` as their ingest enqueue boundary.

## Intentional API break and migration

Previously source responses exposed top-level `status` and `error` strings.
They now expose a typed `state` with `pending`, `ready`, `failed`, or `waiting` status.
Failed and waiting states carry typed reasons. Waiting states include `retryAt`.
External callers must migrate to `state`; no compatibility fields remain.
The generated OpenAPI types and dashboard migrate together.
Retry allowance is stored independently so budget waits cannot erase a previous temporary failure.
The dashboard shows waiting reasons and disables Read again while waiting.

Migration `0022_typed-knowledge-state` follows actual main migration `0021_conversation-scopes-and-audit`.
Snapshot 0022's `prevId` matches snapshot 0021's `id`, `c8ce7255-1408-495e-a44d-9d52776cd6a8`.
The journal appends index 22 after the unchanged main entries 0 through 21.
The migration preserves source fields and passages while translating legacy state.
Unknown legacy errors abort the migration atomically. This is failure rollback, not a tested downgrade after a successful migration.
Existing pg-boss schedules remain authoritative. Migration-time `retryAt` is metadata for legacy waits.
Keep `needs-human` for the API break, schema migration, and security review.

## Combined verification

Evidence is recorded in the append-only local trail `E:/Projects/helpdesk/.helpos/autopilot/279-integration.tsv`.
Run artifacts are under `.helpos/verify/279/` in the integration checkout.
Local artifacts are not repository files or available to remote CI.

Fresh direct runs on the assembled source passed these checks before publication.

| Command or check                                                                                                                                                 | Evidence and limits                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @helpos/server test:page-fetch`                                                                                                                   | 39 tests. Includes meta charset cases that differ from fallback, BOM precedence, and fetch limit transport.                                                                                                                                                                                                                                                                |
| `pnpm --filter @helpos/server exec vitest run src/knowledge/knowledge.test.ts src/jobs.int.test.ts`                                                              | 83 tests against real isolated Postgres. Covers public routes, direct operations and refusals, scopes, foreign tenants, stale writes, duplicate jobs, retry history, passages, and audit records.                                                                                                                                                                          |
| `pnpm --filter @helpos/db exec vitest run src/migrate-knowledge-state.test.ts src/schema.test.ts src/leak.test.ts`                                               | 50 tests. Production migration from the actual predecessor, two-tenant preservation, malformed-state refusal, atomic failure rollback, and forced RLS.                                                                                                                                                                                                                     |
| `pnpm --filter @helpos/db generate`                                                                                                                              | No schema changes. Migration files remain unchanged.                                                                                                                                                                                                                                                                                                                       |
| `pnpm --filter @helpos/web build` followed by `pnpm --filter @helpos/web exec playwright test e2e/knowledge.spec.ts e2e/internal-quote.spec.ts --project=laptop` | 12 tests including setup. Browser drives the composed API, worker, isolated Postgres, and deterministic models. Waiting display, git-owned display, and selected error cases intercept responses. These are display checks; direct integration tests prove server refusals and waiting state.                                                                              |
| Restored negative controls                                                                                                                                       | Five deliberate faults each fail an assertion: fallback, BOM precedence, meta selection, byte limit transport, and erased retry history. Original file SHA-256 values match after every probe. The restored 39-test page suite and retry-history case pass. Reproduction script and outputs are in `.helpos/verify/279/negative-controls.mjs` and `negative-results.json`. |

Script tests and transient negative probes finish before full verification to avoid exposing fixtures to Knip.
The final committed head must pass `pnpm verify` before the single publication push.
The trail records that head, command result, and which Turbo tasks execute freshly or come from cache.
Direct runs above provide fresh behavior proof independently of Turbo caching.
Current-head CI and a fresh independent integration review remain the root owner's publication follow-up.

Prior reviews prove unchanged source portions only.
The page-fetch verdict records fresh direct and negative tests but unavailable live embeddings.
The typed-state verdict records migration, retry, and browser proof, with intercepted waiting display and some cached full tasks.
The operations verdict records fresh direct tests but no completed fresh write journey in its reviewer checkout.
The combined browser run supplies a new deterministic write journey rather than claiming that earlier gap was already covered.
All are same-vendor reviews with their stated limits.

Offline providers prove processing, prompt transport, and assertions.
They do not prove live-model quality or injection resistance. Live provider embedding success remains unproven.
No Claude, Anthropic, or billable provider calls are authorized or needed.
Issue [#205](https://github.com/bsteps/helpos/issues/205) is explicitly deferred and is outside this group's actionable scope.
No send-path function in the formal verification coverage record changes in this group.
The existing send-path findings remain separate; this integration claims no formal verification result or fix for them.

## Remaining group dependencies and proposed order

This knowledge group targets actual main independently of [PR310](https://github.com/bsteps/helpos/pull/310).
PR310 contains only PR250 and PR254 at `atae246736563aa5699650eba67862322b5a585765` and awaits explicit human merge approval.
It is not included and is not a prerequisite for this assembly.
After explicit human approval, integrate this group's sources in the order PR253, PR272, PR275, represented by the preserved chain above.
Do not merge the original PRs separately.

- [PR257](https://github.com/bsteps/helpos/pull/257) must carry its `decodeUndeclared` fallback into `page-fetch.ts` when that separate group integrates.
- [PR270](https://github.com/bsteps/helpos/pull/270) must reconcile its UI decision helper with the typed source response when its group integrates.
- [PR277](https://github.com/bsteps/helpos/pull/277) has a separate migration 0022. Reconcile numbering, journal, and snapshot ancestry at later integration. Neither source branch is rewritten here.

Main movement or an integration fix invalidates the affected evidence and requires final current-head CI.
No merge, closure, branch deletion, or repository-setting change is part of this handoff.
