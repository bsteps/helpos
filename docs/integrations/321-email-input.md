# Email input integration

## Contract

Finish the existing email-input cleanup before feature work. Preserve the reply-safety parent's committed send phases, typed knowledge states, source operations, and tenant boundaries while combining the reviewed fixture, visible-text, and attachment changes.

The preparation parent is exactly `80d10689dc1fe917c8f6364d5015edee9b7ad90e`, [PR 315](https://github.com/bsteps/helpos/pull/315), on `314-reply-safety`. It includes actual main `58451595845f67aef0fb35e0ba584bac71ad1045` and schema migration 0023. The parent's [independent PASS+NOTES](https://github.com/bsteps/helpos/pull/315#issuecomment-6819229569) is not human approval. The parent remains unmerged and is not equivalent to main. This replacement targets `314-reply-safety`. Retargeting to main requires actual approved parent merge accounting first.

Parent source and issue identities remain in [the reply-safety manifest](314-reply-safety.md). This integration does not reapply or close them. Its only issue closure references are 208, 224, 243, and 321.

## Frozen sources

All three original PRs were open at preparation. Their exact heads form one linear chain rooted at old source base `0cb5ba823f010b8fb0ec7ac6061faeb673d31658`. Only the following seven unique commits were cherry-picked, with `-x` provenance, original author identity, and original author date. No stale-main ancestors were imported. Original branches were not rebased or pushed.

| Original                                   | Integrated                                 | Change                                              |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------------------- |
| `e90dd35c3a6ffd77325c340fcf651d263a86bd0d` | `d80f8761e830fc90413bec33a90d48eec3d8386d` | Encoding and outbound threading fixtures, issue 208 |
| `3a6e07db451f9fa8801d5d1dbb6d5286742930c8` | `c76411ffae7f11f3ce9f478918d363ffb511067b` | Captured hidden-text regression test                |
| `30dd4c8d3cf34112ac383766de7d65e3f8438311` | `a5dec69e7d4cbcc0d9edc66069e0750a1b67d360` | Shared visible HTML parser, issue 224               |
| `9f691113228a16f3bf61f56cbc8e9badbd16855d` | `db9c545ffac972209ba71f4e3fa126ae5784ba24` | Attachment storage and filename bounds, issue 243   |
| `db64ef8df0b5cd6f5904080b9b7190d45b2fd053` | `d1d450f4ab6bfb52aee05be361cbf52446a9b48b` | Fixture line-ending normalization                   |
| `c9e7ad52ccbea754f44faab488547d3a4f68117f` | `19d3ad0c9a187b3c89f671956b03554a9c9dac58` | Bounds documentation formatting                     |
| `2e0e3f58641dbdfa47816b756cb41ec4e125a83f` | `bbba9ecb0a0065db3743b50bfae45e40bb7f5e8e` | Fixture generator registration                      |

Original independent verdicts apply to those original heads, not automatically to this integration.

- [PR 281, issue 208, PASS+NOTES](https://github.com/bsteps/helpos/pull/281#issuecomment-6807209007) reports real Postgres and SMTP fixture checks, a restored threading negative, and cache limits on its full gate.
- [PR 285, issue 224, PASS](https://github.com/bsteps/helpos/pull/285#issuecomment-6807466509) reports captured prompt filtering and a restored hidden-text negative. It explicitly makes no live-model claim.
- [PR 289, issue 243, PASS+NOTES](https://github.com/bsteps/helpos/pull/289#issuecomment-6807859040) reports stored attachment bounds, retained raw MIME, duplicate behavior, and a parser counterfactual. That counterfactual was not a source mutation.

## Integration edits

The visible-text parser has one implementation in `@helpos/ai/html-text`. Its email and knowledge formats retain their different line and heading behavior. The source extraction import in the old knowledge worker maps to today's `knowledge/page-fetch.ts`. `Fetcher`, `PageText`, charset decoding, typed source state, source operations, and the worker stay at the parent contract.

The three cherry-pick conflicts were resolved as follows.

- `conversations/routes.ts` keeps the parent's lifecycle and uncertainty filtering and takes only the shared `messageText` import.
- `knowledge/ingest-worker.ts` stays byte-identical to the parent. The shared extractor import moves to `page-fetch.ts`, where the extracted fetch boundary calls it. The obsolete worker imports and callbacks are not restored.
- `docs/architecture/overview.md` keeps the parent's two-phase send and typed knowledge description and adds the source's shared-parser paragraph.

`ecf08ae` adapts issue 208's worker call to `tenantTransactions(db, tenantId)`. This existing parent helper opens every callback through `db.withTenant(tenantId, fn)`. A direct `db.withTenant.bind(db, tenantId)` loses the generic return type under TypeScript 6 and is not assignable to `TenantTransaction`. The helper preserves two separate commits without a cast. All original stored-content, recipient, encoded-header, MIME, and threading assertions remain.

The same integration commit extends the hidden-HTML API test with URL-source creation, a typed `ready` state, captured embedding input, and a draft that retrieves that knowledge. It checks Unicode, paragraph and code newlines, and hidden markers at both model boundaries. The fetch and models are controlled offline adapters. Postgres and the job runner remain real when this test runs.

The required Comment Sicko pass identified five redundant comment blocks in the shared parser. The integration removes their 12 lines and renames internal `preMark` to `preformattedLineMarker`. Parser behavior stays the same. No suppressions, new branches, or sanitization rules were added. The remaining comments describe public contracts or external HTML, CSS, and Postgres constraints.

Git object comparison against the final source head finds 30 of its 38 changed paths have identical blobs, including identical deletions. Eight source paths differ for the following explicit reasons. The added `page-fetch.ts` import is a separate mapped destination, not an additional source feature.

| Source path                                    | Integrated difference                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `conversations/routes.ts`                      | Parent lifecycle and uncertainty filtering retained; shared import only              |
| `drafts/draft-worker.ts`                       | Parent Actor, lifecycle, and typed worker retained; shared import only               |
| `drafts/notice-worker.ts`                      | Parent Actor and lifecycle filtering retained; shared import only                    |
| `inbound-email/email-fixtures-208.int.test.ts` | Existing generic transaction adapter replaces the one-transaction worker call        |
| `inbound-email/hidden-html.int.test.ts`        | Knowledge-ready, captured embedding, and retrieved-draft proof added                 |
| `knowledge/ingest-worker.ts`                   | Exact parent bytes retained; extraction import maps to `page-fetch.ts`               |
| `docs/architecture/overview.md`                | Parent send and typed-state documentation retained alongside shared-parser paragraph |
| `packages/ai/src/html-text.ts`                 | Five redundant comment blocks removed and internal marker renamed                    |

The byte-accounting receipt is `.helpos/321/accounting.json`. It also verifies the exact seven source-to-commit mappings, preserved author identities and dates, common old source base, and unchanged parent send worker, lifecycle, job registry, database job runner, knowledge worker, source operations, and Biome configuration.

## Adjacent ownership

Issue 317 owns fetch decoding and import-rule configuration. This integration changes only the extractor import at its existing fetch boundary. It does not change unknown-charset fallback, Biome configuration, `Fetcher`, or `PageText`.

The reviewed source adds the `@helpos/ai/html-text` package subpath. Issue 226 changes exports in `packages/ai/src/index.ts` and related implementation imports, not this package subpath. Its export cleanup is not included here.

The reviewed source changes the hidden-HTML eval case, adds optional `bodyFormat` to its case schema, and converts HTML before the existing eval task. Issue 229 also touches `evals/case.ts` and `evals/runner.ts`; that overlap needs later integration accounting. Its edge cases, assertion expansion, and model changes are not included. Issue 206's history cases, task, and history tests remain separate. AI cost, quote, and growth work remains with 319. No prompt changes are included.

The only dependency change is the reviewed source's `htmlparser2` 12.0.0 declaration in the AI package and its lockfile entry. The server already uses the same pinned version. No package upgrade or additional library is introduced. Existing AGPL package licenses and third-party license files remain intact.

## Proof

Before assembly, 56 unit characterization tests passed for knowledge extraction, page fetching, and the original email converter. After assembly, all 670 unit tests passed in the `unit` project. The focused shared-parser, knowledge extraction, fetch-boundary, and captured-eval run passed 70 tests again after comment cleanup. Server and AI typechecks passed. Biome check passed with two existing undeclared-environment warnings in `scripts/sync-labels.mjs`.

The coordinator granted the exclusive runtime slot after the other owners released it. Fresh focused execution passed all 14 tests in `email-fixtures-208.int.test.ts`, `hidden-html.int.test.ts`, and `attachment-bounds.int.test.ts`. These exercise the composed public API and real Postgres, pg-boss, Mailpit SMTP, and local attachment files. Captured embedding and draft input proves URL-source ingestion reaches typed `ready` state and visible retrieved knowledge reaches the model. The fixture principals are injected, so the focused tests alone do not establish token authentication. No app journey that calls a live model or a browser was run.

Four integration mutations ran serially through `.helpos/321/prove-integration.cjs`.

- Replacing the thread lookup result with `null` failed both outbound-threading cases with `created` instead of `threaded`.
- Disabling the shared hidden filter failed both captured-input tests, including hidden text reaching the knowledge embedding input.
- Removing the attachment slice failed the storage/API assertion with 21 attachment rows instead of 20.
- Removing filename truncation failed both the stored-name and Unicode filename assertions.

Each mutation restored exact source bytes in `finally`. The restored three-file integration run passed all 14 tests. The first threading experiment used `undefined`, which is outside the lookup's declared result type, and the receipt matcher rejected its different failure. The experiment was corrected to the valid no-match value `null`; no product change was needed. The corrected negative and restored runs provide the recorded evidence.

Fixture generation matched committed content after line-ending normalization. `pnpm test:scripts` passed 107 tests, including the source-fingerprint and accepted-finding regressions. Tooling tests and all mutations finished before Knip.

The stable full gate ran once at `6a6c911b21bd8c4615828491c6d0c3ad302c4073` with `TURBO_FORCE=true` and `EVAL_LIVE=0`. `pnpm verify` passed all 15 tasks fresh, with zero cached tasks. This includes Biome, Knip, typechecks, build and bundle budget, 794 server tests, 109 database tests, 116 AI tests, 48 web unit tests, 64 safe-fetch tests, 11 files tests, 13 brand tests, 29 mock evals, and the demo configuration check. Subsequent edits only update this manifest. The exact receipts are `.helpos/321/verify.log`, `scripts.log`, `focused-integration.log`, `integration-restored.log`, and the four `*-int-negative.log` files.

Offline restored negatives ran through `.helpos/321/prove-light.cjs`. Disabling hidden filtering failed six parser tests, including captured model input containing `hidden-display`. Removing the attachment slice failed with 21 instead of 20. Removing filename truncation failed with the original 260-character name. Each mutation restored exact source bytes in `finally`. The restored 70-test unit run and offline parse checks passed. Logs are under `.helpos/321/`. These are parser and captured-input checks, not evidence of database storage or SMTP delivery.

The send-path coverage functions, model, and fingerprints are unchanged from the exact parent. The fixture adaptation calls its existing transaction adapter and does not alter a covered production function. No fingerprint confirmation is needed. Parent bounded verification is inherited evidence, not a fresh whole-system proof.

Local manual review against the security-baseline and tenant-isolation checks found no new capability, scope, prompt, raw database access, or output-rendering change. Existing sanitization and approval paths remain. All tenant reads in added tests use `withTenant()`. The full gate freshly passed the existing token, cross-tenant, leak, send-invariant, and send-replay suites. This author review does not replace fresh independent integration review or human security review.

All heavy commands exited and no checkout-owned Node process remained before the slot was released to the coordinator. Testcontainers cleaned up their resources. Shared Docker containers and `.env` were preserved. The pre-existing unrelated Mailpit container was left alone.

## Limits and remaining gates

- Missing Message-ID deliveries remain separate conversations. Content equality is not a delivery identity.
- Storage retains the first 20 attachments and truncates decoded filenames to 255 Unicode code points after NUL removal. An overflow note replaces HTML presentation with visible plain text. Raw MIME retains all parts.
- The attachment cap applies after PostalMime parses the message. It does not cap initial parser memory.
- The HTML filter handles tested attributes and inline styles. It does not evaluate stylesheets or classes and does not prove model injection resistance.
- Offline captured input proves deterministic filtering, quoting, transport, and assertions. No live Claude or Anthropic provider, credentials, account setup, or billable call is used. Issue 205 stays deferred.
- The parent's known lost-retry and failed give-up findings remain open. This integration does not claim to fix them or prove eventual delivery.
- Actual current-head CI, fresh independent integration review, and human security review remain required. Keep `pr:in-progress`, `needs-human`, and `security`. No merge, source closure, branch deletion, approval, or protection change is authorized.

The append-only local decision log is `E:/Projects/helpdesk/.helpos/autopilot/321-integration.tsv`.
