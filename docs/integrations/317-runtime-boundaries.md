# Runtime boundary checks and network proof

This integration finishes the reviewed checks from #216, #217, and #230 before feature work. Contributors get executable checks for existing boundaries and local HTTPS and DNS regressions. It adds no product feature or additional rule.

## Parent and frozen sources

Assembly starts at the exact refreshed [PR313](https://github.com/bsteps/helpos/pull/313) head `80e638451a639947fc88cc96af5ee9ef4c73bb7f`, on local branch `317-runtime-boundaries`. That parent contains main `c401a765a80f8e32a16bbdaf03629f20841171dc`, including PR311's migration 0022, typed ingestion state, source operations, current names, unit and integration projects, and worker waits. None of its original source work is replayed or claimed here.

PR313 merged as `58451595845f67aef0fb35e0ba584bac71ad1045`. Its complete tree and the pinned parent tree both equal `76d65b01ff5cace2f0b9070676f2c32190c091cb`. Merge commit `2b4633889cf19f2ef336feb82de75d7a55dffa0f` accounts for actual main once without changing the assembled tree or rewriting the selected commits. The PR targets main and contains only the runtime-boundary delta above that merged parent. The coordinator granted the exclusive heavy slot after #316 released it. Final committed-head gate results and actual cache counts are recorded in the append-only decision trail at `E:/Projects/helpdesk/.helpos/autopilot/317-integration.tsv`.

| Source                                                   | Exact head                                 | Source merge base with pinned main         | Inherited independent review                                                              |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [PR257, #216](https://github.com/bsteps/helpos/pull/257) | `1dd60215ba2635b89dd0af5a2536430733b2177b` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [PASS with notes](https://github.com/bsteps/helpos/pull/257#issuecomment-6805591578)      |
| [PR267, #217](https://github.com/bsteps/helpos/pull/267) | `49bb17d83c72db7e1211d056c8eef67a7ec88d1e` | `ec2dceb6537b08d679295ff1573a77ef2dd75f4d` | [PASS with notes](https://github.com/bsteps/helpos/pull/267#pullrequestreview-5864882754) |
| [PR259, #230](https://github.com/bsteps/helpos/pull/259) | `4457aa19a3ab31c7494860cf4e6e27aae352544a` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` | [PASS with notes](https://github.com/bsteps/helpos/pull/259#issuecomment-6805361353)      |

Original PRs, branches, commits, and discussions stay intact. #317 tracks the integration and does not increase the original cleanup denominator. The PR carries closure references for #216, #217, #230, and #317 for later approval. No merge or source closure is authorized.

## Unique commit mapping

Only these commits are selected, in issue order 216, 217, then 230. Their stale main ancestors are excluded. The assembly SHAs remain in branch history after main reconciliation.

| Issue | Source commit                              | Assembly commit                            | Delta                                                                                   |
| ----- | ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| #216  | `cf416a013ead8a35c4de01d1a94def868546e57e` | `284d48c2fe8041d2b4895660e754142333091c33` | Four existing rule checks, explicit helper error handling, and unknown-charset fallback |
| #216  | `3142fcd6023cbb8f8aabc17b09ca47475b902cf6` | `bd7cb72ca0e2a30ff5b72cb4b94b112892ad3357` | Process metadata and cleanup tests, rule boundary fixtures                              |
| #216  | `e960f8c9edd72c2f5116340ef67a05b0885ac212` | No separate commit                         | Formatting only. Preserve current AGENTS rows and format the combined table once        |
| #216  | `1dd60215ba2635b89dd0af5a2536430733b2177b` | `bcbda2cc73f7f2c4df53dfcafc84ef95a2af7120` | Scope process metadata mocks to the package file                                        |
| #217  | `bfc5099cfe33dc9fc5bd924ce09eb9d7fd19eeb0` | `4c86dcbd73349ee4c59e3356253478725fb98ccd` | Outbound request restriction and allowed-owner fixtures                                 |
| #217  | `49bb17d83c72db7e1211d056c8eef67a7ec88d1e` | `4e8bf453897870d86ad7083b7efd98fce799b6c6` | Named destructuring and template-access bypass fixes                                    |
| #230  | `4457aa19a3ab31c7494860cf4e6e27aae352544a` | `904ea6f69ea4e2bac1a614ddee15406448dd0075` | Real HTTPS and default DNS tests with public test certificate                           |

## Actual integration edits

- The #216 decoder hunk conflicted because PR311 moved fetching out of `knowledge/ingest-worker.ts`. Keep the worker unchanged and apply the `decodeUndeclared` extraction to `knowledge/page-fetch.ts`. Preserve BOM precedence, HTTP and meta charset behavior, the 1024-byte scan bound, UTF-16 handling, UTF-8 validation, Windows-1252 fallback, and page limits.
- Keep the unknown-charset UTF-8 and Windows-1252 cases in `knowledge/page-fetch.test.ts`. The source's database examples repeat these decoder behaviors, so they are omitted. The parent's `knowledge/knowledge.int.test.ts` stays unchanged.
- Keep the current conversation names in the API helper. The source response parser is otherwise unchanged. Its fixture key follows the current `conversationId` spelling.
- Combine the plugin registrations in `biome.json`. Retain every existing plugin and the complete shared `noRestrictedImports` list, including `pg-boss` and the owning-file exceptions. The outbound plugin adds its own tested syntax restrictions without copying those lists.
- Resolve AGENTS table conflicts by retaining the parent's enforcement rows and actual test paths, adding the four #216 rows and #217 outbound row, and removing only the outbound item from the judgment row. Drop the cherry-pick's blank table separator and format the combined table once.

The remaining rule files, helper implementations, rule fixtures, TLS tests, certificate, and key retain their reviewed source content. No suppression, default, policy, credential, or dependency change is introduced.

## Integration review fixes

The independent integration review ran real Biome against bypass fixtures at head `2cb0ef55c5fa585ba93b807e3c843270cb131278`, base main `58451595845f67aef0fb35e0ba584bac71ad1045`. Three forms of the existing rules passed unflagged and are now covered:

- The raw-body check missed Hono's `c.req.blob()` and every body read through `c.req.raw` (`json`, `text`, `formData`, `arrayBuffer`, `blob`). The two raw-body owners stay exempt, and `c.req.raw.headers` stays allowed.
- The outbound check missed `node:http2` and `http2`, which make HTTP requests like `node:http`.

The new fixtures fail against the previous plugins and pass with the fixed ones. Aliased globals (`const g = globalThis; g.fetch`), `Reflect.get`, `self.fetch`, destructured `req`, raw sockets (`node:net`, `node:tls`), `XMLHttpRequest`, `WebSocket` and `sendBeacon` remain outside the named forms.

## Evidence and limits

Inherited evidence remains source evidence. PR257's independent review reports fresh script, knowledge, process, and plain-text API-helper checks, with cached Turbo tasks in its full gate. PR267's independent review reproduces the destructured-global bypass against the old plugin, restores it, and passes its full gate. PR259's review reports 68 fresh safe-fetch tests and mutations for DNS pinning, certificate verification, hostname verification, and localhost blocking, with 15 cached Turbo tasks in its full gate. These reports do not substitute for the final integration gate.

Fresh local assembly evidence is stored under `.helpos/` in this isolated checkout.

| Check                                                                                          | Result                                                                                                                                                            | Evidence                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm --filter @helpos/server exec vitest run --project unit src/knowledge/page-fetch.test.ts` | 39 passed before and after decoder adaptation, uncached                                                                                                           | Direct Vitest output                                             |
| Serial focused Node rule and helper tests                                                      | 74 passed, uncached                                                                                                                                               | `.helpos/317-focused-scripts.log`                                |
| Disable each #216 check, then restore it                                                       | Empty catch, raw JSON body, display name, and filename fixture tests each fail with the check disabled and pass after restoration                                 | `.helpos/317-rule-controls.mjs`, `.helpos/317-rule-controls.log` |
| Restore #217's pre-fix outbound plugin, then restore the selected head                         | The server fixture rejects the old plugin and passes with the selected plugin                                                                                     | `.helpos/317-rule-controls.log`                                  |
| `pnpm --filter @helpos/safe-fetch exec vitest run --no-file-parallelism`                       | 68 passed, uncached, local Node servers only                                                                                                                      | `.helpos/317-safe-fetch.log`                                     |
| Source preservation and restriction comparison                                                 | 13 source files equal after line-ending normalization. All prior import restriction overrides, enforcement rows, current worker, and runtime safe-fetch preserved | `.helpos/317-provenance.mjs`, `.helpos/317-provenance.log`       |
| Affected server and safe-fetch typechecks                                                      | Passed after adapting the imported assertion to `state.status`                                                                                                    | Direct TypeScript output                                         |
| Serial complete Node tooling tests                                                             | 158 passed, uncached                                                                                                                                              | `.helpos/317-all-scripts.log`                                    |
| Required native Comment Sicko, Codex gpt-6.1-sol xhigh                                         | No changes, deletions, flags, or suppressions                                                                                                                     | Owner transcript                                                 |

The first safe-fetch command incorrectly supplied `--project unit` to a package without named projects and ran no tests. The corrected package command above passed. The first Biome pass found the combined AGENTS table needed formatting. Both command corrections are recorded rather than counted as successful gates.

The HTTPS tests retain certificate verification, hostname verification, checked-address pinning, and Host and SNI behavior. Only the local server tests allow loopback. The localhost regression uses the real default resolver and blocking policy. The certificate key is public test data, never a deployed credential. All local servers close in `afterEach`.

Static restrictions cover the named syntax forms. They do not prove complete SSRF prevention. Deterministic mock evals prove machinery, prompt transport, and assertions, not live model quality or injection resistance. No live provider call is authorized. #205 remains deferred and is not a blocker. Unfinished advisory AI jobs provide no completed review, regardless of workflow status.

The final gate runs `pnpm verify` with `EVAL_LIVE=0` after all scratch fixtures are restored. Its output is `.helpos/317-verify.log`, with the exact committed head and outcome recorded in the decision trail. Completed focused proof above is reused. CI and the fresh independent integration review remain separate requirements. Keep `pr:in-progress`, `needs-human`, and `security`. The coordinator owns the independent review. This owner never watches, approves, or merges the PR.

## Later-group overlaps

| Group                  | Concrete overlap                                                                                            | Integration boundary                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Reply #315             | `AGENTS.md` enforcement table and shared lint fixtures may receive unrelated send-path proof changes        | Preserve these runtime-boundary rows and shared fixture helpers when combining later                           |
| AI #316                | `biome.json` plugin registrations, `AGENTS.md` rows, and `scripts/biome-plugins.test.mjs` may add AI checks | Combine registrations and fixtures without replacing existing restrictions or this group's allowed-owner cases |
| Future paid-model #207 | Provider imports or wrappers may overlap `biome.json`, `packages/ai`, and rule fixtures                     | No paid-model rule or import exception is added here. Reconcile only actual later conflicts                    |

Shared `.env` bytes and Docker resources remain untouched. Worktree setup copied the main `.env` byte-for-byte because this Windows account cannot create symlinks. Its SHA-256 was `604264a8e6a93210d1899d0a0c9a028c0df589ed47290353b81cd4b67267c1d1` after setup. No application processes or database were created during assembly.
