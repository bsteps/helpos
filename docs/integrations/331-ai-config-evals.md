# AI startup configuration and offline eval integration

This assembly finishes #215, #229, and #206 before feature work, tracked by [#331](https://github.com/bsteps/helpos/issues/331). It validates configured AI groups before opening services and carries edge inputs and conversation history through the existing drafting evals.

## Pinned prerequisites

The branch `331-ai-config-evals` starts at exact local `328-ai-consumer-boundaries` checkpoint `91620760480544cd7d3a851d5fcfca37c7a549f9`. That checkpoint includes `9af285259969c0a28df4cfeb2235e0237e7fb7de` and the pinned PR315 and PR319 dependencies recorded in [328-ai-consumer-boundaries.md](328-ai-consumer-boundaries.md). The checkpoint's additional tests, pointers, documentation, and selective fingerprints are preserved.

Merge `82bdc547ee63720e07ce8cfeed05cbf2ed3da1c7` combines that first parent with [PR330](https://github.com/bsteps/helpos/pull/330), branch `326-package-command-boundaries`, pinned at `6ccd1232a70f74aabbad7b1e6745468138b5b262`. PR330 includes PR320. Prerequisite ownership and source assignments remain with #328 and #326. Neither prerequisite branch is pushed or rewritten here. The owner has published [PR336](https://github.com/bsteps/helpos/pull/336), branch `328-ai-consumer-boundaries`, at `41f08b6feecd7ed25a160a8beb5d6775db1085bc`. Root confirms its later changes are documentation only. The source pin remains `91620760480544cd7d3a851d5fcfca37c7a549f9`; this assembly does not refresh it. The dependent PR targets `328-ai-consumer-boundaries`.

## Frozen sources and applied commits

Only the following selected originals are newly covered. Merge-base deltas exclude their historical parents. PR268 is stacked on PR264, whose commit is applied once.

| Original                                                 | Frozen head                                | Unique delta base                          |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| [PR263, #215](https://github.com/bsteps/helpos/pull/263) | `598583268c371ac4687e5a55cbb4f605e4da7e6e` | `19c68cfaef774a0d7afdfb75700a56892c6e06a7` |
| [PR264, #229](https://github.com/bsteps/helpos/pull/264) | `737a2842ea48045050d897b4302b76679b3efa99` | `ec2dceb6537b08d679295ff1573a77ef2dd75f4d` |
| [PR268, #206](https://github.com/bsteps/helpos/pull/268) | `7b4d45578462a13fcfad22a5c1e2f181a0c4e611` | `737a2842ea48045050d897b4302b76679b3efa99` |

All six commits retain original Git author Nishant Tadvi <nishant.tadvi@yahoo.com>, author timestamps, and `cherry picked from commit` trailers. Source discussions identify an Astra high author and Sol xhigh independent verifiers. Git metadata alone does not prove model provenance. This assembly uses GPT-6.1-sol xhigh.

| Source commit                              | Applied commit                             | Purpose                                                        |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------- |
| `90f2d2d3d8ea304df440534bf34081501f3a99a8` | `6ea78c58fc3e144cf3744a16faf6fdcff0b0a5e7` | Reproduce invalid startup configuration.                       |
| `9aa293f76673f6caa0f3096153905136f4aca3d0` | `daf6d263398b62f8cc18d8d7ac3bc18112346f5b` | Parse optional AI groups before opening services.              |
| `e508609f694f52cfb510d0330d60315ffc3c1c74` | `68c75cc457c26d5967ece64d6df56b84912839a6` | Use synthetic credentials in the demo configuration fixture.   |
| `598583268c371ac4687e5a55cbb4f605e4da7e6e` | `5397d779a0c1a1e740cc0df299af6b7a157dcf2c` | Keep the no-key development example valid and cache-sensitive. |
| `737a2842ea48045050d897b4302b76679b3efa99` | `fde5ab454351b6457eec351d96f18776dc01024a` | Add edge cases and captured-prompt assertions.                 |
| `7b4d45578462a13fcfad22a5c1e2f181a0c4e611` | `e13574b9f857f549f3754e35bd16c844ac59245a` | Add the three history cases and their transport tests.         |

## Inherited reviews and limits

- [PR263 PASS+NOTES](https://github.com/bsteps/helpos/pull/263#issuecomment-6805898275) covers the pinned head and supersedes the earlier missing-key example failure. It includes actual no-key startup and a fresh full-suite run. The source doctor reported AI unavailable in that deliberately disabled configuration. No live drafting proof is inherited for that case.
- [PR264 PASS+NOTES](https://github.com/bsteps/helpos/pull/264#issuecomment-6805824229) covers the four edge cases, independent transport and citation mutations, fresh AI units, and an earlier reply journey. Scripted offline answers prove transport and assertions, not live model judgment.
- [PR268 PASS+NOTES](https://github.com/bsteps/helpos/pull/268#issuecomment-6806057868) covers its six-file delta against PR264. It preserves the owner's disclosure of accidentally running historic live cases with configured Claude Haiku. This assembly does not repeat that call. Its prior full gate was cache-backed.

All three source advisory security, tenant-isolation, and test-signal jobs reported incomplete analyses. Green workflow conclusions and zero inline findings are not completed reviews. These source verdicts do not approve the integration edits. Root owns fresh independent final integration review. Human approval remains required for startup defaults and security changes.

## Actual integration changes

The retained data shapes are parsed optional `AiConfig` and `EmbeddingConfig`, `PaidModels`, `JobDeferral`, explicit knowledge audiences, and ordered inbound or outbound history. No new dependency, schema migration, endpoint, or model policy is introduced.

| Area                                         | Integration mapping                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisite merge                           | Preserve both sets of Biome rules and their regression fixtures. Preserve paid AI enforcement and the whole Drizzle re-export and schema namespace.                                                                                                |
| `cli/token.ts`, `cli/token-command.ts`       | Keep the extracted executable wrapper. Move the existing `builtInActors.tokenCli` identity into the extracted command instead of restoring the old inline command or the legacy system actor literal.                                              |
| `http/route-kit.ts`, `github/issue-draft.ts` | Keep the current `auditContext` function used by prerequisite routes. Drop the unused `Auditor` re-export. Domain code imports `Auditor` from the audit module and retains `mapAiRefusal`.                                                         |
| `ai-budget/budget.int.test.ts`               | Combine the moved `setAiBudget` import and CLI proof with 328's busy-regenerate test. Do not restore the obsolete `AiBusyError` import.                                                                                                            |
| `packages/db/src/index.ts`                   | Retain the used `JobDeferral`, `hasSearchableKnowledge`, and `KnowledgeQuery` contracts. Keep `installJobs` internal because its consumers are internal. Keep the other 330 export removals.                                                       |
| `packages/ai/src/draft-issue.ts`             | Retain the module export of `issueInstructions` used by the existing captured-schema cost test. The root barrel still omits it. Keep exact schema costs, paid options, output cap, and zero retries.                                               |
| `packages/ai/src/index.ts`, `env.ts`         | Export and explicitly consume `AiConfig` and `EmbeddingConfig` so the transformed schema has portable named types. Remove the unused root `PaidModel` re-export while keeping paid handles in helper signatures and the restricted budget subpath. |
| `cli/init-command.ts`                        | Apply PR263's shared `defaultPublicUrl` in the actual extracted command. `cli/init.ts` remains the three-line executable wrapper.                                                                                                                  |
| `turbo.json`                                 | Keep both `.env.example` and `vitest.config.mts` as global cache inputs.                                                                                                                                                                           |
| `evals/case.ts`, `evals/task.ts`             | Keep the prerequisite's strict history schema with `default([])`, which already supplies omitted history to both tasks. Keep both isolated paid contexts. Do not restore raw-model drafting or duplicate history fallback adapters.                |
| Edge runner and fixtures                     | Keep source264's capture of actual provider prompts, model-object typing, exact boundary checks, mixed language, empty input, and unknown citation handling.                                                                                       |
| History fixtures                             | Keep all three source268 cases and their order, omission, output, tool, and schema tests. The pre-existing normalized history path makes its schema and task edits redundant.                                                                      |
| Prerequisite manifest                        | Format the inherited 328 tables for the current Biome gate without changing their content.                                                                                                                                                         |

Token and schema bounds, conservative embedding usage charges, CJK quote detection, cumulative busy failure allowance, explicit knowledge audiences, typed source state, visible HTML extraction, and email/send boundaries remain intact. The inherited send-model findings stay unresolved and no new eventual-delivery claim is made.

## Proof and execution limits

The bounded units are prerequisite merge, source263, source264, source268, current export contracts, and final proof. Existing source tests pin behavior. No new architecture exploration, source refresh, optional mutation campaign, or feature work is included.

| Check                                 | Observed result                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined-prerequisite AI behavior pin | 133 tests passed after retaining the used instruction export. The initial run failed its exact schema-cost assertion because that export was missing.                                                                                                                      |
| Final assembled AI unit suite         | 147 tests in 11 files passed fresh. `.helpos/331-ai-unit.log`.                                                                                                                                                                                                             |
| Server unit suite                     | 447 tests in 37 files passed fresh, including startup subprocess probes and CLI argument fixtures. `.helpos/331-server-unit.log`.                                                                                                                                          |
| Offline evals                         | 38 passed with `EVAL_LIVE=0`. `.helpos/331-eval.log`.                                                                                                                                                                                                                      |
| Workspace compiler                    | All seven tasks passed after the current export mappings. `.helpos/331-typecheck.log`. Initial compiler failures identified the used audience and portable config types.                                                                                                   |
| Knip                                  | Passed with all package entry-export checks enabled and no suppressions. `.helpos/331-knip.log`.                                                                                                                                                                           |
| Repository script suite               | 180 tests passed. `.helpos/331-scripts.log`. This command unexpectedly included a Java-dependent TLC regression. It finished before discovery and was disclosed to root. It is a resource-restriction breach, not an authorized fresh model proof. No repeat is permitted. |

The standalone offline receipt passed the actual development example, all four executable CLI usage exits, all three ordered history prompt captures, and the huge-body retained boundary with its excluded tail. The script and receipts are `.helpos/331-offline.mjs`, `.helpos/331-offline.log`, and `.helpos/331-offline-receipts.json`. Its first attempt imported the environment parser from the wrong module and failed before execution; the corrected script uses Node's `parseEnv`. Original-to-assembly range comparisons are `.helpos/331-range-263.log`, `.helpos/331-range-264.log`, and `.helpos/331-range-268.log`. The paid-model compiler fixture passed independently in `.helpos/331-paid-types.log`.

Biome passes with the three inherited warnings, the void union and two sync-labels environment dependencies. The first lint attempt overlapped temporary script fixtures. A later lint attempt found only inherited 328 Markdown table formatting, which was formatted. These failed attempts are not passing evidence.

Root granted the prepared focused Postgres command after the 328 full gate exited. One owned Testcontainer used actual migrations, pg-boss installation, and fresh databases for CLI, budget, busy-queue, busy-retry, and knowledge tests. The sequential run passed 107 tests in five files. Docker inspection confirmed 536870912 memory bytes and 1000000000 NanoCpus. The fixture `.helpos/331-pg-setup.mts` and config `.helpos/331-focused.config.mts` record that setup. The container was removed and private port `127.0.0.1:35437` was released. The local `.env` hash is unchanged. This run started no SMTP service, browser, TLC, or live provider. Root then granted the final full slot at clean committed head `3cbc655865c3bb8542db3c2ddf79edeb1169e957`. The single plain `EVAL_LIVE=0 pnpm verify` exited 0. Source stayed frozen through exit. Deslop found no required cleanup. The one native GPT-6.1-sol xhigh Comment Sicko reported zero deletions, restores, workaround flags, suppressions, or open constraints. Fresh independent final integration review remains root-owned, and hosted checks and human approval remain separate gates. The append-only [331-integration.tsv](331-integration.tsv) records decisions, grants, and observed outcomes.

The final gate passed all 15 Turbo tasks, eight fresh and seven cached. Every package test suite ran fresh, server 829, database 114, AI 147, safe-fetch 68, web 48, brand 12, and files 11. The web build ran fresh and its initial JavaScript passed the repository budget check. All seven typechecks used valid cache entries from earlier successful checks. All 38 mock evals and the demo configuration check passed. The log is `.helpos/331-verify.log`. Biome retains its three existing warnings, and the web build retains its chunk-size advisory. No force flag, script-suite repeat, or TLC repeat was used.

The full gate exited and its owned Testcontainers resources were removed. The older Mailpit container created on November 11 remains untouched. The local `.env` hash is unchanged. Subsequent edits record proof only in this manifest and trail; production and test source remain identical to the tested head. Git ancestry checks retain both exact prerequisite pins. The published 328 tip differs from its pinned checkpoint only in its two integration documents. The forge CLI `origin` is unavailable, so publication uses `gh`.

Issue #205 is deferred. No live key request, provisioning, billable eval, Claude call, or provider request is authorized. Offline models prove prompt transport, assertion wiring, citation parsing, and deterministic boundary behavior. They do not prove live quality or injection resistance. Do not run the live verify-helpos journey. Publication retains `pr:in-progress`, `needs-human`, and `security`. Source PRs and branches remain open and unchanged. No merge, approval, closure, deletion, settings change, or watch is part of this task.
## Post-review startup-probe correction

Independent review at `04f505e` reproduced two CI failures. The tests launched relative `src/main.ts` from the repository root and reached `MODULE_NOT_FOUND` instead of configuration validation. The earlier package-directory gate remains valid for its own invocation; it did not cover this root launch.

The probe now resolves `main.ts` relative to the test module and explicitly runs its child from the repository root. The existing exit, variable-name, secret-redaction and no-connection-error assertions remain. This makes the regression reproducible even when Vitest itself is invoked from the server package. No production startup or provider configuration changes.

The forced-root probe fails both original startup cases before the entrypoint fix. After the fix, all 14 environment tests pass from the repository root and all 14 pass from the server package. Server typechecking also passes. Receipts are `.helpos/337-startup-before.log`, `337-startup-root-after.log`, `337-startup-package-after.log` and `337-startup-typecheck.log`.

The earlier production, Postgres, CLI and offline prompt evidence remains inherited for unchanged source. Current-head CI and a fresh focused independent recheck are still required for this test-only correction. No new database, browser, live-provider or model campaign was run.

## Reviewed parent reconciliation

The startup correction passed its fresh independent recheck at `a4db10d`. GitHub could not create its pull-request merge because the updated parent conflicted with an inherited Markdown table. The parent's reviewed head `d5b1e290cfcdabeeb2667932bf9d6d68f00919e5` is now normal-merged. A normalized comparison confirmed this child had changed only table alignment and separator widths in the parent's integration record; the reviewed parent text is retained in full.

The merge inherits the parent's growth-clock regression correction and its qualified AI-history description. Public reply history excludes unconfirmed outbound messages; the AI history query still lacks that filter. No runtime history fix is claimed. The startup probes and all other child production and test files remain unchanged from `a4db10d`. Existing whole-integration and Postgres evidence is inherited for those unchanged files. Focused affected checks, a fresh integration-delta recheck and current-head CI cover this reconciliation.

Fresh reconciliation checks passed all 150 AI unit tests, all 14 startup environment tests invoked from the repository root, AI typechecking and scoped Biome. The merge changes only the two parent proof documents, the parent growth helper and its test, and this record; all other child files are byte-preserved. Receipts are `.helpos/337-parent-ai.log`, `337-parent-startup.log` and `337-parent-ai-typecheck.log`. Current-head CI and the independent reconciliation verdict remain pending.

## Independent review and security review

Fresh review at `fa69973` used parent `d5b1e290cfcdabeeb2667932bf9d6d68f00919e5` and prerequisite `6ccd1232a70f74aabbad7b1e6745468138b5b262` as fixed points and covered only this assembly's own delta. Separate standards and spec reviews found no documented-standard breach. The spec review found one real gap: the huge-body eval banned only phrases from inside the tail, so a cut up to ten characters too long still passed. Raising the limit to 4,010 characters left all 38 offline evals and the edge tests green.

The eval and its unit test now also ban the boundary marker followed by the first tail character. Raising the limit to 4,001 characters fails both; the real 4,000-character cut passes. The startup redaction cases now include chat and embedding key values, and the demo environment example says that a provider with an empty key stops startup. Remaining standards notes are judgement calls and are not changed.

The security review of this delta and its integration points found no vulnerability at confidence 8 or above. Invalid-setting errors name variables without values, a failing schema keeps keys and database passwords out of the error, the parsed keys are never logged, all 13 Biome plugins remain, the token command keeps its audit actor, and tenant boundaries are unchanged. Fresh checks after the fix passed 150 AI unit tests, 38 offline evals, 14 startup tests, typechecking and Biome. Offline evals still prove transport and assertions, not live quality or injection resistance. AI history drafting still lacks the public history's filter for unconfirmed outbound messages; that runtime fix belongs to the parent integration.
