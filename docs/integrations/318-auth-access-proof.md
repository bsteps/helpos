# Tenant, session, and member access proof

This integration combines the existing access proofs before feature work. Maintainers get tests of pooled tenant isolation, session age and cookie attributes, real member restrictions, and observable API outcomes. Product behavior and permissions stay unchanged.

## Base and frozen sources

The base is `58451595845f67aef0fb35e0ba584bac71ad1045`, the current `origin/main` at assembly. It contains approved [PR313](https://github.com/bsteps/helpos/pull/313). The landed knowledge migration 0022, typed knowledge state, unit and integration projects, and worker waits are inherited once.

Only the unique diff from each actual merge base to its selected head is applied. No stale source history is merged or replayed. All four original PRs were OPEN at these exact heads when assembly began.

| Order | Source | Exact selected head | Actual merge base with main | Source review |
| --- | --- | --- | --- | --- |
| 1 | [PR255, #221](https://github.com/bsteps/helpos/pull/255) | `69efadaf0d807518f352311a5f1f852d72283c6e` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [Pool reuse, rollback, and restored negative](https://github.com/bsteps/helpos/pull/255#issuecomment-6805137155) |
| 2 | [PR256, #244](https://github.com/bsteps/helpos/pull/256) | `28708aa1e726796522cd2563e0a74315612ea698` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [Session boundary and cookie proof](https://github.com/bsteps/helpos/pull/256#issuecomment-6805366840) |
| 3 | [PR265, #231](https://github.com/bsteps/helpos/pull/265) | `9a0ccb42d8a6cfd70bd2b3ab8b58f9a06cbb72a9` | `ec2dceb6537b08d679295ff1573a77ef2dd75f4d` | [Real member browser and leak proof](https://github.com/bsteps/helpos/pull/265#issuecomment-6805889178) |
| 4 | [PR274, #201](https://github.com/bsteps/helpos/pull/274) | `0eaaec423b770b2c117c668213c9a896529983e7` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | [Observable token, audit, job, and disconnect outcomes](https://github.com/bsteps/helpos/pull/274#issuecomment-6806835190) |

## Source and integration commit mapping

Integration commit `be67d93ae23564b18a3488259cbc794175ae9d70` applies these selected changes in the table order. It changes 13 files, with 257 added lines and 85 removed lines. The source commits map to this one assembly commit rather than becoming ancestry.

| Source | Exact source commits represented | Integration change |
| --- | --- | --- |
| #221 | `69efadaf0d807518f352311a5f1f852d72283c6e` | Inject a supplied pool into the existing database factory; prove one backend is reused without tenant leakage; prove rollback and exact callback error identity. The returned database owns and closes the injected pool. |
| #244 | `28708aa1e726796522cd2563e0a74315612ea698` | Exercise real sign-in and `/v1/me` just before and after seven days; inspect the HTTPS cookie attributes. |
| #231 | `90a7bb807dc77a74fef5028c7ee3944b94ec25d5`, `9a0ccb42d8a6cfd70bd2b3ab8b58f9a06cbb72a9` | Set the seeded member's password through the existing setup path; exercise actual member API and dashboard permissions; remove the impossible human knowledge-write mock. |
| #201 | `0eaaec423b770b2c117c668213c9a896529983e7` | Replace token collaborator, warning-text, and orphan-log assertions with authentication results, budget state, audit rows, claims, queued jobs, and disconnect results. |

The only production delta is `packages/db/src/client.ts`. Its URL path retains the same pool settings. The transaction body, transaction-local setting, RLS, rollback behavior, and error propagation are unchanged. Auth defaults, scope lists, policy code, and route code are unchanged.

## Accepted session criterion

The owner accepted detecting a changed session lifetime and insecure cookies. Six-day and eight-day mutations must fail the boundary cases. Removing `expiresIn` keeps the same seven-day behavior because pinned Better Auth 1.7.17 defaults to seven days. The historical literal-criterion failure in the source review is superseded by this accepted behavioral criterion, not an unresolved source defect.

The canonical owner decision is the `2026-11-12T01:14:46.0553294+05:30` row in `E:/Projects/helpdesk/.helpos/autopilot/root.tsv`. Issue and source PR documentation were updated. No test of configuration spelling or change of defaults is included. Criterion acceptance is not security or merge approval.

## Filename mapping and overlaps

The actual `241-rename-map.tsv` and `200-test-path-mapping.tsv` in `E:/Projects/helpdesk/.helpos/autopilot/` supply the mappings.

- #221's `packages/db/src/client.test.ts` maps to `packages/db/src/client.int.test.ts`. Both this test file and `client.ts` match the selected #221 blobs exactly.
- `draft-knowledge.int.test.ts`, `github.int.test.ts`, and `sessions.int.test.ts` already have their current names. No old test filename is restored. Main's migration tests remain integration tests.
- The session conflict combines #244's new boundary tests with main's conversation test name and `/v1/conversations` paths. All existing session assertions remain.
- The GitHub conflict combines `jobsForLink` with main's `waitFor` and `waitForTenantJobs` imports. Main's settlement waits and assertions remain. The reviewed recheck test uses persisted jobs for the disconnected interval; it does not restore the old local polling helper.
- The E2E setup keeps main's conversation terminology. E2E support keeps the `conversationId` response mapping. The knowledge E2E file keeps main's typed source state, retry assertion, and git-managed source case.
- `packages/db/src/testing.ts` keeps main's shared setup, settlement helper, and diagnostics, and adds only the reviewed tenant-and-link-scoped job read helper.
- The sole Comment Sicko pass removed the two added lines that narrated demo password setup. No application code, suppressions, or additional cleanup changed in that pass.

Seven of the 13 selected file blobs remain identical to their source heads. The six adapted files are the session suite, E2E server, knowledge browser suite, E2E support, GitHub integration suite, and DB testing helper. Each difference is covered by the overlaps above. The local blob accounting is `.helpos/integration318/blob-accounting.tsv`.

## Contract and implementation shape

`createDatabase` accepts a URL or an existing `postgres.Sql` pool and returns the same `Database`. The tests supply one connection to observe backend identity directly. No parallel database abstraction or public Actor type is introduced.

Existing `Principal` and member role scopes already support the selected tests. Typechecking found no dependency on the separate reply-safety group. The reviewed shape is preserved instead of opening a new design or refactor.

## Fresh evidence

Light assembly checks completed before heavy-slot activation:

| Command | Result |
| --- | --- |
| `pnpm --filter @helpos/server exec vitest run --project unit src/tokens/token.test.ts` | Fresh 19/19 tests passed. |
| `pnpm --filter @helpos/server exec vitest run --project unit src/auth src/tokens/token.test.ts` | Fresh 156/156 tests passed. |
| `pnpm exec vitest run --project unit` | Fresh 639/639 tests in 50 files passed. No integration setup. |
| `pnpm typecheck` | Seven tasks passed. DB, server, and web ran fresh; four unaffected packages used cache. |
| `pnpm check` | Passed after normalizing two conflict-resolution files to LF. Two existing sync-label environment warnings remain outside this group. |
| `pnpm knip` | Passed. |
| `pnpm exec vitest list --project int --filesOnly` | The current pool, session, leak, migration, draft, and GitHub suites are selected by the integration project. |

Fresh heavy evidence is pending coordinator activation of the exclusive DB, Mailpit, browser, and full-verification slot. No combined DB or browser pass, restored mutation result, or final `pnpm verify` result is claimed at this checkpoint. Source reviews support unchanged portions only; they do not prove this assembled integration.

## Remaining gates and limits

After slot activation, run focused real Postgres pool reuse, rollback, session boundary, HTTPS cookie, leak, scope, and audit tests. Run the real member dashboard and API cases on laptop and phone with offline providers. Restore meaningful pool, session, token, and member negative probes before Knip and the stable final `pnpm verify`.

The single new replacement PR targets actual current main only after local readiness. Keep `pr:in-progress`, `needs-human`, and `security`. A fresh independent integration review and human security approval remain mandatory. This group has no merge approval.

The existing source review notes a remaining tenant-filtered warning count in the unreadable webhook-secret test. It is not a warning-text match and is not strengthened by this integration. Later route sweeps #197, typed audit #85, API conventions #10 and #233, and the separate #315, #316, and #317 work stay excluded. The only test fixture addition here is the real seeded member's password and identity, plus the reviewed recheck job reader.

No live AI journey or provider credentials are needed. #205 remains deferred. Offline providers prove app mechanics, not model quality or prompt-injection resistance. Shared Docker and environment files stay untouched; tests may clean up only resources they own. Original PRs, branches, and discussions remain frozen. Tracking #318 is excluded from original issue counts.

The append-only decision trail is `E:/Projects/helpdesk/.helpos/autopilot/318-integration.tsv`.
