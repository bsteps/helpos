# Verification foundation integration

This bounded integration covers [tracking issue #278](https://github.com/bsteps/helpos/issues/278). It combines migration consistency and proof-presence checks before feature changes. The owner authorized this two-source group to avoid repeated strict-main CI. It does not authorize a merge.

## Source inventory and commit mapping

Both source PRs were OPEN at their pinned heads when checked on 2026-11-12. Both source histories start at `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` and contain exactly the two commits mapped below.

| Source PR and covered issue                                                                             | Exact reviewed source head                 | Inherited independent review                                                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| [PR250](https://github.com/bsteps/helpos/pull/250), [#222](https://github.com/bsteps/helpos/issues/222) | `7ad8b560bcf23033c31712cc0fe013cfa7fff2bd` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/250#issuecomment-6806701982) |
| [PR254](https://github.com/bsteps/helpos/pull/254), [#199](https://github.com/bsteps/helpos/issues/199) | `75062ff7c51253b134595599d6d5686a0376403b` | [PASS+NOTES](https://github.com/bsteps/helpos/pull/254#issuecomment-6806735148) |

| Source PR | Source commit                              | Preserved integration commit               |
| --------- | ------------------------------------------ | ------------------------------------------ |
| PR250     | `77daad7a2f4dda2b4958ffb98987f0eb8d6a9c05` | `c0560dc2ab2182aab5cd1913778c03b7b0910f94` |
| PR250     | `7ad8b560bcf23033c31712cc0fe013cfa7fff2bd` | `5379305dffe43843df3952c9dd3a129c886431ac` |
| PR254     | `5a3b8978de115343a9a51d74a63ed19cff153fbe` | `7e3c109fff83bfda7f6e31de67e739dc946fbdfe` |
| PR254     | `75062ff7c51253b134595599d6d5686a0376403b` | `e0e7b64acafb542188e6caee13b5cae7e0f30d75` |

The source reviews describe Astra high authorship and Sol xhigh verification, different models from the same vendor. The PR250 verifier identifies itself as `gpt-6-sol xhigh`. Git authorship remains Nishant Tadvi, and PR250 also carries `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` trailers. These records are preserved, not rewritten into a single model attribution. This integration was prepared by Codex `gpt-6.1-sol xhigh`. The planned fresh integration verifier uses the same model and vendor as this implementation, so its independence is a fresh context, not model or vendor diversity. No live Anthropic calls are part of this integration's verification.

## Assembly, base, and reconciliation

- Original assembly branch is `278-verification-foundation`, with head `e0e7b64acafb542188e6caee13b5cae7e0f30d75` and base `0cb5ba823f010b8fb0ec7ac6061faeb673d31658`.
- Publication branch is `278-verification-foundation-ready`, created from that preserved head in a new T3 checkout. The original branch and safe-checkpoint checkout remain intact.
- A single current-main fetch returned `0cb5ba823f010b8fb0ec7ac6061faeb673d31658`, also the final current-main base for this integration. No rebase or replay was necessary.
- The existing assembly reconciles the shared AGENTS enforcement table. Every main row, including the expanded tenant-leak rule, and both added rules occur once. Table padding changed to accommodate the longer proof rule. There are no other source conflict resolutions.
- Non-AGENTS patches match each mapped source commit exactly. Final migration-test, workflow, and proof-script Git blobs match the pinned source heads. The assembled file inventory equals the union of the two source inventories. Source histories have no additional unrepresented commits or dependencies beyond the common main base.
- The only change after the preserved assembly is this manifest. No production code, migration SQL, package dependency, existing required CI gate, security setting, or send-path model coverage changes.

To inspect the content comparison, run `git diff 7ad8b560bcf23033c31712cc0fe013cfa7fff2bd HEAD -- packages/db/src/migrations.test.ts` and `git diff 75062ff7c51253b134595599d6d5686a0376403b HEAD -- scripts/proof-check .github/workflows/proof-check.yml`. Both must be empty. Compare each mapped commit with `git show <commit> -- . ':!AGENTS.md'`, and compare AGENTS rows after trimming table padding.

## Inherited verification

The linked source reviews cover only their exact source commits. PR250 records fresh migration and database tests, schema-drift and repeated-setup negative probes, and full verification. PR254 records fresh script tests, real Git CLI behavior, mutation controls, and full verification. Their older CI queue statements are historical observations, not current status and not combined-head evidence.

## New combined verification

Fresh checks on the preserved combined source content passed on 2026-11-12:

- `pnpm --filter @helpos/db exec vitest run src/migrations.test.ts` passed both tests against a throwaway real Postgres 17 with pgvector, including current migrations 0020 and 0021.
- A temporary `integration_probe` column in the tenants schema, without a migration, failed the drift test with the expected `ALTER TABLE` statement.
- A temporary migration runner inserted an `integration-probe` history row on each setup. The repeat-setup assertion detected the additional row on the second run.
- Both probes restored their original files byte for byte in `finally` blocks. The focused migration tests then passed 2/2 again.
- `pnpm test:scripts` passed 99/99, including all 13 proof decision and workflow/CLI tests. The CLI tests invoke the shipped command in a real temporary Git repository. They assert failure for missing proof, success with proof, an explicit literal exception, rejection of an invalid SHA argument, and merge-base behavior when the base advances independently.
- Deslop found no required edits. Native Comment Sicko found no required deletions, suppressions, or open constraints. Its live drizzle-kit probe confirmed the external zero-exit error behavior documented by the migration test's comment.

The publication gate additionally requires `pnpm verify` on a stable committed combined head. Its exact SHA, result, cache use, and final fresh affected-test results belong in the replacement PR and the append-only local log at `E:/Projects/helpdesk/.helpos/autopilot/278-resume.tsv`. Tooling tests and negative probes finish before full verification so transient fixtures cannot affect Knip. Fresh independent integration review and required hosted CI remain separate gates; this manifest does not claim them complete.

## Limits and human decision

The proof gate enforces changed path presence, not test quality or coverage. A standalone `Proof: not needed because ...` line is an intentional documented waiver, not proof. It can allow a missing proof path. This integration adds the workflow without changing repository merge requirements.

The schema check compares Drizzle's committed schema and migration metadata. The repeat-setup test compares the migrated catalog, privileges, migration history, and pg-boss metadata. Neither check substitutes for application acceptance tests.

Application behavior is unchanged, so no browser or live-AI journey is needed for this group. No covered send function changes, no model fingerprints are blanket-confirmed, and no known send-path finding is claimed fixed. #205 remains secret-blocked, #22's actual-widget criterion still needs a human decision, and the other source groups are excluded.

Retain `needs-human` from the included sources. Do not apply `land`. Keep both source PRs open and preserve branches, commits, and discussions. A human must approve the concrete integration after the fresh independent review and required CI. Consolidation authorization and API-Break metadata do not authorize merging. Closing #222, #199, and #278 belongs only to a future authorized merge.
