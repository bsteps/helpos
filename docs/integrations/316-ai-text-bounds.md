# AI text bounds integration

This integration finishes the existing safeguards for large and multilingual AI inputs before feature work. It combines the unique changes for #223, #225, and #227. It adds no AI capability or shipped dependency.

## Base and source mapping

Assembly starts at PR313 head `80e638451a639947fc88cc96af5ee9ef4c73bb7f`, which contains actual main `c401a765a80f8e32a16bbdaf03629f20841171dc`. That parent contains PR311 migration 0022, the unit and integration test projects, current-main renames, and worker waits. PR313 merged as `58451595845f67aef0fb35e0ba584bac71ad1045` at `2026-11-12T08:12:20Z`. Both parent trees are `76d65b01ff5cace2f0b9070676f2c32190c091cb`. One local rebase onto that actual main preserves the complete integration tree, proven by `git diff --exit-code 5241251 86fe621`. No original source branch changes.

All three frozen sources have old common base `19c68cfaef774a0d7afdfb75700a56892c6e06a7`. Only their unique commits above that base are applied, in this order. Original branches, commits, and discussions remain intact.

| Issue and source | Source commit                              | Assembly commit                            |
| ---------------- | ------------------------------------------ | ------------------------------------------ |
| #223, PR252      | `6462aa8c9a7aa98edfe3bd575447b23c2a9f307b` | `6c13662953ef3634abde48ec4edb0b3dea14cd6b` |
| #223, PR252      | `72099f26bfadf117b1fca905d6bd2fd3f55f5829` | `627afe43f48c6e7860515849f678f8e791ba7eeb` |
| #225, PR258      | `5da478168a82819d4b1cb7f66aae06599a298fef` | `16de7719f195f05968d0ddc2f13d41b0b4881ad8` |
| #225, PR258      | `8a530ee456b7e3be6c5440562350e665440ee811` | `f7221fa508f22471433b55680e6ad1834fe8597e` |
| #227, PR262      | `f30258d96761a9c30be2d509865a64a051727fd6` | `cb746abd8bc292aa2751bd6cac836605fffa3f8c` |

After the one main reconciliation, those five assembly commits map in order to `b7fbdeaf4549b099b8e3548cc652da071d0cfe3c`, `d2d57ab4e23630e86fdf97b18492a2aa304fef2f`, `997568733dcf31df17266c49aa57d31827e898e1`, `e6084f7b760832ff738f90434f66e077cc29959b`, and `cbb4b2ef696eae503e233c7f10c0fc684dec1fbe`. Assembly manifest commit `5241251` maps to `86fe621`. The original source and assembly commits remain available locally.

The only textual conflict is adjacent imports in `draft-issue.test.ts`. Resolution keeps `fenceEmail` and `tokenBound` from #225 and `expectLinearGrowth` from #227. The #225 cost-estimate section remains unchanged when #227 is applied. Production files require no conflict edits. The parent already uses conversation terminology in eval types; Git merges the source comment correction without changing those types.

## Preserved contracts

`quoteWords` uses `Intl.Segmenter` after the existing case, punctuation, and apostrophe normalization. Japanese and Chinese verbatim notes receive a warning. The thresholds remain ten shared words and four distinct content words. Short shared phrases and support boilerplate remain negative cases. The API computes the warning when it reads the draft, so editing out the quote clears the warning.

The issue estimate counts the actual SDK structured-output schema. Generation passes the same `issueOutputSchema` to `Output.object`, and the model-spy test compares the schema it receives. The output cap remains 2,000 tokens. Missing, zero, and invalid embedding usage charges `tokenBound(...batch)`; valid positive usage remains the provider's reported value.

The committed English, Chinese, Japanese, emoji, and code fixtures retain their exact counts and reproduction script. They sample tiktoken 0.12.0 with `cl100k_base` and `o200k_base`. They do not prove provider framing or every tokenizer. No fixture regeneration or dependency addition is needed.

Regex regression tests use the inherited warmed, calibrated, batched pairs at n and 8n. Output assertions stay inside the helper's checks, after each timed batch. Seven alternating pairs use a median growth limit of 24 with a minimum measured small batch above one millisecond. These ratios detect regressions; they are not production-speed measurements.

## Inherited reviews

- [PR252 independent report](https://github.com/bsteps/helpos/pull/252#issuecomment-6805160562) records PASS+NOTES at the exact frozen head. Astra authored and Sol verified, both Codex. It records fresh quote tests, offline evals, restored negative controls, and a Japanese warning/edit Playwright flow. Live embeddings were unavailable. An unchanged job-test timeout passed on rerun and remains a historical flaky-test note.
- [PR258 independent report](https://github.com/bsteps/helpos/pull/258#issuecomment-6805380878) records PASS+NOTES at the exact frozen head. Astra authored and Sol verified, both Codex. It independently reproduced fixture counts, captured the actual SDK schema, rejected cost mutations, and checked the public usage endpoint. Its complete verification used Turbo cache, followed by fresh focused execution. No live embedding claim follows from those checks.
- [PR262 attributed independent report](https://github.com/bsteps/helpos/pull/262#issuecomment-6805592462) records the coordinator's account of a completed Sol verifier, with Astra authorship. Fresh targeted tests and output-preserving quadratic mutations passed the expected positive and negative checks. Complete verification used Turbo cache. Direct verification was Windows Node 24, with no separate Linux or app run for that test-only patch.

These reviews cover their source heads, not this combined integration. Advisory AI workflows reported successful workflow conclusions while saying they did not finish; those are not substantive reviews. No human approval is inherited.

## Integration evidence

Focused execution uses `pnpm exec vitest run --project unit packages/ai/src` from the repository root. Running the project filter from `packages/ai` finds no projects because that package has no Vitest config; the root invocation selects the pinned parent's unit project without Docker.

- Applying the #223 tests before its fix reproduces the Japanese and Chinese misses. Applying its fix passes all 16 quote tests.
- Applying the #225 tests before its fix fails seven assertions across schema and embedding cost tests. Its fix passes all 55 focused tests.
- After #227, fresh direct execution passes all 130 AI unit tests. `EVAL_LIVE=0 pnpm eval` passes all 31 offline cases, including the Japanese quote and CJK schema-cost cases. Direct AI typecheck and scoped Biome checks pass.
- Restored negative probes reject the parent quote matcher in both the quote tests and Japanese eval, omitted schema cost, the old embedding fallback, and a reduced byte bound. Output-preserving quadratic scans inserted into the real sanitizer and citation parser fail the inherited growth assertions. Each mutation restores the exact original file bytes. Fresh restored AI unit tests and offline evals pass again.
- Deslop finds no required change. The one native Comment Sicko reviews the combined source diff at `cb746ab` with the same model and effort as the integration owner. It finds zero required deletions, suppressions, or open constraints. This is not the independent integration review.

Local probe code and individual assertion logs are under `.helpos/verify/316/`. `negative-controls.mjs` executes mutations serially with byte restoration in `finally`. The first schema probe matched a different source expression and stopped without changing the file; correcting that probe to remove `issueSchemaTokenBound` reaches the intended failing assertion. Scripts and mutation fixtures finish before Knip or full gates run.

The coordinator grants the exclusive heavy slot after #314 releases it. The completed pure tests, negative controls, offline evals, and Comment Sicko remain valid because reconciliation changes ancestry without changing file bytes. No repeat is needed for a model or process change.

The existing `internal-quote.spec.ts` laptop flow passes fresh with the server's mock note temporarily replaced by the committed Japanese eval note. Its owner-setup dependency also passes. This uses the real server, worker, knowledge ingestion and retrieval, Postgres, and built dashboard with mock chat and embeddings. A separate shared-browser pass verifies the public draft API flags the Japanese quote, shows the dashboard warning, then clears both after an edit through the dashboard. `GET /v1/ai-usage` returns 200 with 330 input tokens, 30 output tokens, and 360 total tokens across two calls. This proves warning/edit transport and deterministic accounting, not live provider behavior.

`japanese-server.mjs` restores the temporary server fixture byte for byte on process exit. The temporary Playwright config is removed. The noninteractive process session has closed stdin, so its stdin shutdown hook cannot run; the owned server process is stopped, its wrapper restores the fixture, and Testcontainers cleans its own session `5812aab52559`. The original shared Postgres and Mailpit containers stay running. The shared browser tab closes, and port 4173 is free. `browser-api.json`, `japanese-e2e.log`, and before/after screenshots retain the observations under `.helpos/verify/316/` and the browser artifact directory.

Repo script checks run serially after restoration and before Knip. The required publication gate is `EVAL_LIVE=0 pnpm verify` at the stable committed head containing this manifest. Its exact SHA, outcome, cache hits, and fresh tasks are recorded in the append-only decision trail and replacement PR. Hosted CI and a fresh independent integration review remain coordinator-owned gates.

## Later overlaps and limits

The paid-handle, deferral, and search-audience group #207, #203, and #204 remains separate. So do edge/history evals #229 and #206, HTML #224, and package exports #226. This integration changes `draft-issue.ts`, `draft-reply.test.ts`, and shared cost tests that later AI work may touch. `packages/ai/src/index.ts` and the package export map remain unchanged. Existing callers of the quote detector, draft estimates, and embeddings retain their signatures. A later export cleanup must account for those real callers; this branch adds no compatibility wrapper or unrelated patch.

#205 is deferred because credentials are unavailable and is never a blocker. No key, account, secret, or live provider access is requested. No billable eval or Claude/Anthropic call runs. Offline checks prove deterministic machinery, prompt transport, and assertions, not live quality or injection resistance.

The shared `.env` and Docker remain intact. Only this isolated checkout's processes and test databases may be cleaned up. Keep `pr:in-progress` and `needs-human` for the AI security behavior and cost defaults. No merge, approval, source push, issue closure, branch deletion, or settings change is authorized. New tracking #316 does not change the original cleanup denominator.
