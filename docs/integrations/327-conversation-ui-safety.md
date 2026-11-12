# Conversation UI safety integration

## Scope and dependency

This integration groups existing conversation safety and failure-state cleanup before features. It covers only #234, #238, #236, #237, and #218. Tracker #327 records assembly and does not count as another original.

The exact prerequisite is [PR325](https://github.com/bsteps/helpos/pull/325) at `f0044229520c44eda8a571f2c8379bdf37037334` on `323-dashboard-quality`. This branch starts there and targets that branch without waiting for merge or approval. The prerequisite includes `80d10689dc1fe917c8f6364d5015edee9b7ad90e` from PR315. Those prerequisite changes are inherited, not reapplied or counted among the five originals.

## Frozen sources and actual commits

All five source heads have merge base `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` with the pinned prerequisite. Each delta below applies once. Cherry-picks preserve Nishant Tadvi's authorship and add source-hash trailers.

| Issue and source                                         | Frozen head                                | Source dependency and merge base                 | Applied source commits                                                                 | Integration commits                                                                    |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| #234, [PR273](https://github.com/bsteps/helpos/pull/273) | `62227ffeea535a317e8c0f835221c636d6bbedbf` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658`       | `8376475e8bd0b4dbf6df7b28f5f57d58104fda92`, `62227ffeea535a317e8c0f835221c636d6bbedbf` | `f7fc2c9cbb35bec675f58be6938487fac5a1bfe0`, `a32a45f3bf9bf8eb5a9abc33c14aced9bc534445` |
| #238, [PR283](https://github.com/bsteps/helpos/pull/283) | `5b62e76120ee54fa5de92d0fdc25dbe7ac21795e` | PR273 `62227ffeea535a317e8c0f835221c636d6bbedbf` | `5b62e76120ee54fa5de92d0fdc25dbe7ac21795e`                                             | `774e905e4647addba35d331b3dcb8a673edfa047`                                             |
| #236, [PR287](https://github.com/bsteps/helpos/pull/287) | `65ac720995e550aa7ca9d7aaccefa542e63c4238` | PR283 `5b62e76120ee54fa5de92d0fdc25dbe7ac21795e` | `a9f3be47cd2286cba10e564ee56a98e58d3a54fd`, `65ac720995e550aa7ca9d7aaccefa542e63c4238` | `37f802fb5c1bf2bbc6b51067be9b2d8a8164e135`, `36ada9dda8274d413d659e784ae4dcaeac9e9e05` |
| #237, [PR288](https://github.com/bsteps/helpos/pull/288) | `46f0c10915017ecaf6205bde6de4154d415688ef` | PR287 `65ac720995e550aa7ca9d7aaccefa542e63c4238` | `f563f8c39c68e109b5cbd89979c82269e554684e`                                             | `f8809bad34d5d261624626052e9b2890ce9a43d6`                                             |
| #218, [PR291](https://github.com/bsteps/helpos/pull/291) | `74ff6eab5f820c38e178cbb5b6215e399abd568e` | PR288 `46f0c10915017ecaf6205bde6de4154d415688ef` | `74ff6eab5f820c38e178cbb5b6215e399abd568e`                                             | `1c56d97f6fa980b562d248dc551ea5cae74c00b5`                                             |

PR288's head is a merge of `f563f8c` and `65ac720`. Its unique test delta comes from `f563f8c`. The merge contributes no additional source delta, so importing it would duplicate already applied ancestors. No source branch is rebased, refreshed, pushed, closed, or deleted.

## Conflicts and retained contracts

- The #234 conflict is in `knowledge.tsx` imports. Keep the parent's `knowledge-form.ts` helpers and add `webHref`. Remove only the duplicate `webLink` implementation and change its caller. All typed pending and waiting behavior remains.
- The #238 conflict is in `conversation.tsx`, where the source removes code that the parent extended for uncertain delivery. Move the parent's complete panel into `conversation-drafts.tsx`. Preserve the exhaustive `Record<Draft["status"], ...>` badge map derived from public `AnimatedBadgeProps`, the `useResolveSend` hook, busy and conflict handling, and both `mark_sent` and `send_again` decisions. No private UI exports return.
- The source title and description helpers replace the inline copy. Add the parent's `send_uncertain` wording to `draftDescription` and to both kind and timestamp-precedence cases. Keep timestamp precedence and fixed-notice copy. All existing draft-view polling, history filtering, latest-message, automated-mail, and composing behavior remains.
- The safe-link browser fixture predates the typed knowledge API. Replace its obsolete top-level `status` and `error` fields with a complete `KnowledgeSource` fixture using `state: { status: "ready" }` and `satisfies KnowledgeSource`. No production schema or generated API changes are needed.
- GitHub failure assertions retain the fixed GitHub-region scope and forbidden-headline assertions. Inbox tests retain the normal-mail control and actual pending-draft wait. Session tests retain real cookies, public API 401 and 404 checks, a real second workspace, unchanged draft text after sign-in, and hidden foreign content. These four E2E specs stay dedicated.
- The prerequisite's 114 helper tests, trimmed props, eight decision helpers, typed knowledge pending and waiting helpers, contrast colors, phone viewport assertion, and both uncertainty choices remain. No old phone assertion, unscoped error query, old job wait, or competing schema contract returns.

## Biome composition and ownership

The entire `biome.json` difference from `f004422` is one include, `apps/web/src/routes/**`, in the existing 600-line route override. Import restrictions, their owner exceptions, schema version, and plugin registration are byte-for-byte inherited. Boundary tests exercise both server and web routes at 600 and 601 lines.

Group #326 owns the separate domain-HTTP plugin addition. Later composition must retain its `./biome-plugins/domain-http.grit` registration and plugin tests while retaining this web-route include and line-limit tests. The hunks are distinct. Neither group replaces the parent's complete Biome object or restriction list. This branch imports no #326, #328, or #329 source delta.

## Inherited exact-head reviews

The following reviews apply to the unchanged source portions. They are separate same-vendor runs, not vendor-independent reviews, and they do not replace fresh final integration review.

- [PR273 review](https://github.com/bsteps/helpos/pull/273#issuecomment-6806632497) is PASS+NOTES for `62227ffeea535a317e8c0f835221c636d6bbedbf`. It records 60 fresh web units, fresh typecheck, five focused browser checks, and restored unsafe-anchor controls. Its full gate had 15 cached tasks. The dev doctor could not run without an environment file, so its browser evidence uses the composed test app.
- [PR283 review](https://github.com/bsteps/helpos/pull/283#issuecomment-6807445369) is PASS+NOTES for `5b62e76120ee54fa5de92d0fdc25dbe7ac21795e` against PR273. It records 26 draft-view tests, 88 script tests, fresh typecheck and build, 70 browser passes with one existing skip, and a restored title mutation. Its full gate had 15 cached tasks. The initial Knip failure overlapped a temporary tooling fixture and the stable rerun passed.
- [PR287 review](https://github.com/bsteps/helpos/pull/287#issuecomment-6807863734) is PASS+NOTES for `65ac720995e550aa7ca9d7aaccefa542e63c4238` against PR283. It records 13 focused browser passes and a restored wrong-headline control with a second draft alert. The real API, Postgres, and authentication ran with deterministic AI and fake GitHub. Its full gate had 15 cached tasks.
- [PR288 review](https://github.com/bsteps/helpos/pull/288#issuecomment-6807834954) is PASS+NOTES for `46f0c10915017ecaf6205bde6de4154d415688ef` against PR287. It records 27 fresh draft-view tests, nine focused browser passes, and restored automated-guard and badge-text controls. Its full gate had 15 cached tasks. Advisory AI checks did not finish.
- [PR291 review](https://github.com/bsteps/helpos/pull/291#issuecomment-6808113666) is PASS+NOTES for `74ff6eab5f820c38e178cbb5b6215e399abd568e` against PR288. It records seven focused browser checks, 65 fresh web tests, fresh typecheck, real cookie removal and 401 recovery, real foreign-workspace 404 checks, and restored redirect, status, and bare-link controls. Its full gate had 15 cached tasks. Advisory AI checks did not finish.

## Integration proof and remaining gates

The parent passed all 114 web tests before assembly. The assembled branch passes 132 fresh web tests, fresh web typecheck, focused Biome checks, and seven Biome configuration tests. The production build reports 181.9 KB of the 200 KB initial JavaScript budget. This is a bundle budget check, not a latency benchmark.

A local TypeScript AST check passes 27 comparisons. It compares conversation functions, moved panel functions and maps, and existing draft-view declarations. It also checks protected parent files byte for byte and confirms the sole Biome change. `DraftCard` differs only in its extracted title and description expressions, whose behavior the copy tests pin for both kinds, every current status, and sent-time precedence. Artifacts are `.helpos/327-equivalence.mjs` and `.helpos/327-equivalence.json`. The first scratch run referenced a nonexistent helper filename. Correcting those scratch paths made the check pass without application changes.

Stable full verification, focused composed browser proof, and the sole native Comment Sicko receipt are recorded below after execution. Source negative controls remain valid for unchanged portions. No optional negative campaign or full browser campaign is needed.

The append-only trail is `E:/Projects/helpdesk/.helpos/autopilot/327-integration.tsv`. The coordinator owns runtime scheduling. This checkout uses only isolated resources and private ports when granted. The setup copied the shared environment file without editing it. Both environment files start at SHA256 `604264a8e6a93210d1899d0a0c9a028c0df589ed47290353b81cd4b67267c1d1`.

No live provider calls, billable evals, Claude, credentials, or live GitHub writes are authorized. Offline checks prove machinery, not live AI quality or injection resistance. #205 stays deferred and known send stalls stay open. No send-path production function changes, so existing formal findings are not claimed fixed.

Publication stays `pr:in-progress`, `needs-human`, and `security`. Fresh independent integration review, current-head CI, and root human approval remain required. No watch, approval, merge, settings change, source closure, or source deletion is authorized.
