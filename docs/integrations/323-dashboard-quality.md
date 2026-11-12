# Dashboard quality integration

This integration finishes the existing dashboard cleanup before feature work. It trims unused copied component options, extracts the existing form decisions, and carries forward the accessibility and phone sweep with its selected contrast fixes.

## Exact dependency

The dependency is PR [315](https://github.com/bsteps/helpos/pull/315), branch `314-reply-safety`, pinned at `80d10689dc1fe917c8f6364d5015edee9b7ad90e`. It includes actual main `5845159`, uncertain-send recovery, and exhaustive draft badge maps derived from public component props. It is open, unmerged, and awaiting human approval. The dependent PR targets `314-reply-safety` while that parent remains unmerged. Main `5845159` does not contain it.

The parent retains ownership of its backend, migration, schema, generated OpenAPI, and reply-safety changes. This integration adds no changes to those paths. Its comparison base is the exact parent, not main.

## Frozen sources and mappings

Each source remains open and preserved. Cherry-picks retain original authorship and record their source hashes. No source branch is refreshed, pushed, deleted, or closed.

| Issue and PR                                           | Exact frozen head                          | Actual merge base with the dependency      | Integration commit                                                                          |
| ------------------------------------------------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| #235, [266](https://github.com/bsteps/helpos/pull/266) | `cafd457799956518ccd87cf0f253a8d2c10b6bb9` | `ec2dceb6537b08d679295ff1573a77ef2dd75f4d` | `4c784384c2755761299eb43d6e91ae859bd72d8a`                                                  |
| #232, [270](https://github.com/bsteps/helpos/pull/270) | `870f9ec152f992081a55886142afc06aecc75844` | `ec2dceb6537b08d679295ff1573a77ef2dd75f4d` | `4f732a55d8a2c1b766c1c1927e38dab1fdea054d`                                                  |
| #239, [271](https://github.com/bsteps/helpos/pull/271) | `82410061f180ad6095f823f7682f9cc9e2d3e162` | `0cb5ba823f010b8fb0ec7ac6061faeb673d31658` | `cacb55725ce1876e3f3431f5d171b18e919b73a3`, then `b6af7cba42c9c1f27a0ed387125e5620846bc385` |

The first #239 commit maps `7cd8ae0ff92cf089bb32ac99c4bb572f1351c7fd`. The second maps the exact frozen head's viewport correction. The deltas apply in the order #235, #232, #239. Issue #323 tracks the assembly and is outside the original-issue denominator. Source replacement accounting remains a later approval step.

## Real conflicts and retained contracts

- The #235 conflicts affect `alert.tsx`, `button.tsx`, and `input.tsx`. The parent already removed unused exports, the button link, alert close controls, hand-written client aliases, and unused motion tokens. Only the remaining unique option implementations are removed. Private variant types stay private. MIT headers and the full notice remain. Generated API schemas remain byte-identical to the dependency.
- The #232 conflict affects `knowledge.tsx`. `knowledgeChangedMeanwhile` consumes `Pick<KnowledgeSource, "title" | "visibility" | "state" | "updatedAt">`. It preserves both pending and waiting ingestion warnings from the current parent. Tests use typed failure and waiting reasons. No legacy top-level status or error field returns.
- All eight decisions remain present. Error-code and HTTP-status precedence, auth and session wording, blank titles, sparse edit bodies, and concurrent-edit conditions retain the parent's behavior. No auth API, token storage, approval, or session handling changes.
- `conversation.tsx`, `inbox.tsx`, and `draft-view.ts` remain byte-identical to the dependency. The parent public-prop-derived exhaustive badge maps and uncertain-send controls survive without casts, obsolete status exports, or a weakened `Record`.
- The accessibility spec retains six screens, both password states, long subjects and source URLs, webhook secrets, edit forms, and confirmation coverage. Phone overflow uses `page.viewportSize().width`, not `innerWidth`. Successful audits attach screenshots for human presentation review.
- The color changes match #239 exactly. Primary becomes `#0055aa`, danger becomes `oklch(54% 0.22 25)`, and light success and warning badges use emerald-700 and amber-800. These selected fixes still require human product approval.

## Shared boundaries and later consumers

No selected source requires a Biome configuration delta. `biome.json` and import-rule ownership remain with #317 and PR320. There is no ignored hunk, suppression, or competing rule change. If later checks expose a real prerequisite, publication must wait for the coordinator to serialize and pin it.

The later #234, #238, #236, #237, and #218 group overlaps the conversation panel, outbound links, component props, and decision helpers. Its integration must preserve the public `AnimatedBadgeProps["status"]` contract, the retained button and alert props, all eight helpers, typed knowledge state, and the parent's uncertainty controls. It must not copy the old full screen files over these changes. AI #319, auth #322, and email #324 remain separate.

## Proof and limits

The source reviews remain evidence for unchanged behavior, with their original limits:

- [#235 review](https://github.com/bsteps/helpos/pull/266#issuecomment-6805983890) covers the UI trim, login keyboard behavior, alert and input negative controls, and original browser flows. Its live journey did not prove knowledge retrieval.
- [#232 review](https://github.com/bsteps/helpos/pull/270#issuecomment-6806423668) covers exact decisions, auth messages, and restored precedence and sparse-title controls. It identifies the typed-state adaptation now made here.
- [#239 review](https://github.com/bsteps/helpos/pull/271#issuecomment-6806635259) covers the contrast sweep and the 600px Login mutant rejected against the configured 412px phone viewport. Product color approval remains open.

Before assembly, the pinned parent passed 48 web tests, web typecheck, and the production build. After assembly, 114 web tests, web typecheck, focused Biome checks, and the production build pass. The reported dashboard bundle is 182.0 KB gzipped within the 200 KB budget. This is a budget result, not a performance benchmark.

A local AST extraction check compares the eight current decisions directly with the exact parent's function bodies and inline expressions. It passes 971 comparisons. The first scratch check had an automatic-semicolon-insertion bug in its generated function; trimming the extracted expression corrected that check. The application code did not change for it. Local artifacts are `.helpos/323-equivalence.mjs` and `.helpos/323-equivalence.log`.

Three fresh decision mutations fail the intended cases, then the restored 66 decision cases pass. They change the 404 branch, remove trim-aware sparse-title comparison, and remove the waiting-state warning. Artifacts are `.helpos/323-negative-404-precedence.log`, `.helpos/323-negative-sparse-title.log`, `.helpos/323-negative-waiting-edit.log`, and `.helpos/323-restored-decisions.log`. The mutation runner restores the source bytes in a `finally` block.

The inherited test-only `@axe-core/playwright` and `axe-core` packages are pinned at 4.14.0 and declare MPL-2.0. They add automated contrast and accessibility checks, are outside the shipped bundle, and retain their package licences. The source review accepts their licence compatibility. Registry metadata confirms their respective 4.14.0 publication dates of October 15 and October 5, 2026, with updates in November. No other dependency is added.

The coordinator explicitly activated the exclusive browser, Docker, and full verification slot after #321 and #322 released it. Heavy checks use the existing disposable composed server with mock AI and fake GitHub, never this checkout's configured live provider.

The initial and restored focused Playwright runs each pass nine cases. They include the owner password setup, laptop and phone accessibility sweeps, login alerts with keyboard submission, and both uncertain-send choices. Each sweep audit attaches a screenshot. Reviewable visuals are in `apps/web/playwright-report/index.html`, including primary buttons, failed-source alerts, connected badges, and confirmation states. `.helpos/323-focused-browser.log` and `.helpos/323-restored-browser.log` record the runs.

The fresh phone mutation inserts `body { min-width: 600px }` before the Login audit. The actual phone sweep fails with `Received: 600` and `Expected: <= 412`. The fresh contrast mutation restores the old primary, danger, success-badge, and warning-badge colors. The laptop sweep rejects those colors with serious `color-contrast` violations. Logs are `.helpos/323-negative-phone.log` and `.helpos/323-negative-contrast.log`. Both mutations restore the spec and color files byte for byte, rebuild, and rerun the focused cases successfully. The old source's alert-role and input-change negatives remain inherited proof for unchanged component behavior.

The sole native Comment Sicko pass reports zero findings, deletions, suppressions, or unenforced constraints in the added or altered comments. Deslop retains only the selected source changes, required typed-state adaptation, two additional waiting cases, and screenshot evidence. No optional redesign or test architecture is introduced.

The stable final full run occurs once after restored controls and final commits. Its exact head, command, outcome, and fresh versus cached task split are recorded in the append-only trail and PR evidence. A pending or failed full receipt does not mean locally ready. Fresh independent integration review and current-head hosted CI belong to the coordinator.

The setup copied `.env` into this worktree because Windows symlinks were unavailable. No environment file is committed or edited. The worktree and shared environment hashes both remain `604264a8e6a93210d1899d0a0c9a028c0df589ed47290353b81cd4b67267c1d1`. Shared Docker and other writers remain untouched. No credentials, paid evals, live Claude, Anthropic, or other provider calls are authorized. Offline checks do not prove live model quality or injection resistance. #205 remains deferred.

The append-only decision trail is `E:/Projects/helpdesk/.helpos/autopilot/323-integration.tsv`. PR state stays `pr:in-progress` and `needs-human`, never `land`. Human auth, presentation, and color-default approval remain required. No merge, approval, source closure, source deletion, or settings change is authorized.
