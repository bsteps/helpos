---
name: verify-send-reply
description: Model-checks the reply send path (approve, the send-reply job, SMTP, commit, pg-boss retries and give-up) with TLA+, against four promises, under worker crashes, lost SMTP replies, failed commits, expired job leases and a failed give-up. Use before you merge any change to a function in its coverage record, refactors, moves and renames included, when you work on #130 or the give-up/lost-retry finding, and when pg-boss is upgraded.
---

# Verify the send path

Read [EVIDENCE.md](EVIDENCE.md) for model results, real-code mutation proofs and the `/statechart` review.

Sending an approved reply has an irreversible customer-visible effect. This check explores every order of steps in a small model of the send path, not only the orders a test happens to run, and checks four promises in each state.

| Promise | In the model | Harm when it breaks |
| --- | --- | --- |
| The customer gets a reply at most once, unless a person asked to send it again. | `NoResendWithoutPerson` | The customer gets the same email twice (vision rule 5). |
| Once nothing is left running, a reply that went out is shown as sent. | `NoHiddenDelivery` | A person sees `send_failed` for a reply the customer already has, and sends it again. |
| An approved reply is always still being sent, or shown to a person. | `NoSilentStall` | The reply never goes out and nobody is told. |
| A reply goes out only while its draft is approved. | `SentOnlyWhenApproved` | A discarded or unapproved reply reaches the customer. |

## When you must run it

- Any PR that changes a function in the coverage record below. That includes refactors, moves, renames and splits: the model pins the behaviour, not the file layout.
- The fix for #130 must turn its counterexamples into passes (see "Changing the model").
- A pg-boss upgrade: its version is in the coverage record, because the model copies its retry, expiry and settle rules.

## Run

```bash
pnpm verify:send-reply
```

It needs Java 11 or newer on PATH. The first run downloads TLC 1.7.4 (pinned by SHA-256) into `.helpos/tools/`. A full run takes about 15 seconds.

It runs one fault at a time, checking each promise, then pairs each mutant in `model/mutants/` with the unchanged model under identical constants and faults. The unchanged control must hold and the mutant must break its promise. Exit 0 means two things: every result matches the expected table (the `runs` list in `scripts/check.mjs`, with known findings identified below), and every function in the coverage record matches its fingerprint. Each line starting `!!` says what is off and what to do. The TLC files for every result are in `.helpos/verify-send-reply/<run>/<promise>/`.

## Read every result with `/statechart`

For any broken promise, new or known, read its folder with the pstack `/statechart` skill. It gives the shortest path to the broken state in plain words. When everything holds, it draws how a draft moves between states. Then decide:

- **A real bug** replays on the real code. Replay the path one action at a time against the code that the coverage table maps it to, as a test on the harness in `apps/server/src/drafts/send-failed.int.test.ts` (real Postgres, pg-boss and Mailpit). For example, a transport that sends and then throws reproduces "SMTP accepted, then the transaction rolled back". Report it with the path in the code's words, and add it to `known` with its issue. Never change a promise to make it pass.
- **A modeling error** doesn't replay. Look for the first action where the model and the code differ. Usually one model action is split by an `await` in the code, the model lacks a guard the code has, or the model has a guard the code lacks. Fix the model, rerun, and write in the PR what was wrong.

## Changing the model

When a change to covered code is intended, change the model to match before you trust a pass:

1. Edit the actions in `model/SendReply.tla` that the coverage table maps the changed function to. Preserve the observable commit boundaries. SMTP acceptance, the application transaction commit, and pg-boss settlement are separate actions.
2. Keep the promises as they are. The one allowed change: add a status to `ToldItWent` that tells a person the reply may have gone out (#130's `send_uncertain`).
3. A new guard in the code gets a mutant in `model/mutants/`: the file replaces whole operators, and its header names the run and the promises the break must fail.
4. Rerun. A known finding that now holds stops the run until you remove it from `known` in `scripts/check.mjs`.
5. Once the model describes the code at your commit, run `pnpm verify:send-reply --confirm`. It records the new fingerprints and the commit. Only run it after you have checked the model against the code. Its diff in SKILL.md is what a reviewer reads as "confirmed".

For #130: model its two-phase send (commit a `sending` marker, then SMTP, then `sent`; a retry that finds `sending` asks a person). Under `commit_fails`, `smtp_reply_lost` and `worker_dies`, the #130 counterexamples must become passes. `NoSilentStall` remains a separate finding until the lost-retry and give-up failure paths are fixed.

## Coverage record

<!-- coverage -->
Last confirmed at commit `077f34bb526b`. The two nested runner rows were rechecked against parent `80e638451a63`, which removes the unused system-job branch and casts. Tenant payload parsing, rollback, last-attempt give-up, two committed send steps, and pg-boss settlement retain their model actions. Conversation-write extraction and audit details were selectively re-fingerprinted below against the same model actions. Other fingerprints remain unchanged. The #328 assembly selectively rechecks `defineJob`, `consume`, and `work` against the two-phase send contract. `handleSendReply` returns no deferral, so no send successor is enqueued by the new AI deferral branch. The logging wrapper still awaits and rethrows failures, the last-attempt condition and rollback-before-give-up order stay intact, and pg-boss settles after the callback. The model and its inputs are unchanged. Known lost-retry and give-up stalls remain open.

| Module | Function | Model steps | Fingerprint |
| --- | --- | --- | --- |
| apps/server/src/outbound-email/composer.ts | outboundMessageId | PersonApproves, PersonResolvesResend (Message-ID generation) | `e5a275b0a465` |
| apps/server/src/outbound-email/composer.ts | composeEmail | WorkerLocksAndChecks, PreparationFails (MIME preparation before the marker commit) | `0703cec0ca33` |
| apps/server/src/drafts/send-worker.ts | handleSendReply | WorkerLocksAndChecks, WorkerRechecksMarker, PreparationFails, SmtpAccepts, SmtpRejects, SmtpReplyLost, TransactionCommits, TransactionCommitFails | `2e188d038b39` |
| apps/server/src/conversations/lifecycle.ts | addMessage | WorkerLocksAndChecks, PreparationFails (prepared outbound insert) | `020e1b6717de` |
| apps/server/src/conversations/lifecycle.ts | markMessageSent | TransactionCommits, PersonResolvesSent (message sentAt) | `f28d8643de0c` |
| apps/server/src/conversations/lifecycle.ts | recordActivity | TransactionCommits, PersonResolvesSent (conversation lastMessageAt) | `5f93e14833be` |
| apps/server/src/conversations/lifecycle.ts | removeRejectedMessage | SmtpRejects (remove unaccepted preparation) | `b52ac63e24c0` |
| apps/server/src/drafts/send-worker.ts | handleSendGaveUp | GiveUpMarksFailed, GiveUpFails | `360cf5ea8938` |
| apps/server/src/drafts/lifecycle.ts | isApprovedDraft | WorkerLocksAndChecks, SmtpRejects | `dee671731e8f` |
| apps/server/src/drafts/lifecycle.ts | isSentDraft | WorkerLocksAndChecks, SmtpRejects | `785296718047` |
| apps/server/src/drafts/lifecycle.ts | isUncertainDraft | WorkerLocksAndChecks, SmtpRejects | `dbc8777e2d84` |
| apps/server/src/drafts/lifecycle.ts | draftTransitions | MarkSendFailedFrom, and the status guards of every Person action | `12c52c5be6fa` |
| apps/server/src/drafts/lifecycle.ts | change | the conditional update and row lock every status change goes through | `2d5a1057fb04` |
| apps/server/src/drafts/lifecycle.ts | changeDetails | audit inputs within every Person and Worker transaction | `bba5eacea934` |
| apps/server/src/drafts/lifecycle.ts | queueSend | Enqueue | `1d94c013aa00` |
| apps/server/src/drafts/lifecycle.ts | approveDraft | PersonApproves | `7a552dec2357` |
| apps/server/src/drafts/lifecycle.ts | retrySend | PersonRetriesSend | `70a6a6dbe8d5` |
| apps/server/src/drafts/lifecycle.ts | discardDraft | PersonDiscards | `86be6a5eba54` |
| apps/server/src/drafts/lifecycle.ts | markSending | WorkerLocksAndChecks | `1cbbda9a6c54` |
| apps/server/src/drafts/lifecycle.ts | rejectSend | SmtpRejects | `67eb47b77809` |
| apps/server/src/drafts/lifecycle.ts | resolveUncertainSend | PersonResolvesSent, PersonResolvesResend | `b4dbff48c01d` |
| apps/server/src/drafts/lifecycle.ts | markSent | TransactionCommits | `97968274f48d` |
| apps/server/src/drafts/lifecycle.ts | markSendFailed | GiveUpMarksFailed | `1ab4b0b08c2b` |
| apps/server/src/jobs.ts | jobs | send-reply worker registration | `f36a5585f881` |
| apps/server/src/jobs.ts | defineJob | transaction wiring and give-up wrapper | `313382219f6f` |
| apps/server/src/jobs.ts | sendReplyRetry | RetryLimit | `29d5382a4c16` |
| packages/db/src/jobs.ts | APP_ENQUEUE_SQL | Enqueue (singleton key) | `1e14891501d5` |
| packages/db/src/jobs.ts | createJobRunner.consume | Fail: onGiveUp only on the last attempt, after the rollback | `1c5921f6eb32` |
| packages/db/src/jobs.ts | createJobRunner.work | two committed transactions per send attempt (`steps`) | `0ac5978b52bb` |
| pg-boss | version | WorkerClaimsJob, Settle (attempt fence), JobLeaseExpires | `12.38.0` |
<!-- /coverage -->

## Scope

**Checked.** One draft, from `pending` through approval, every send attempt and the give-up, with a person's retry and discard able to interleave. Two workers, so a slow attempt and its retry can overlap.

**Bounds.** One retry (the code has 8). Attempts past the first all take the same steps, and the model covers both the "retries left" and the "last attempt" branch. One person retry. One fault per run, at most once. Raise `MaxFaults` in `scripts/check.mjs` to look for bugs that need two faults. Each extra fault makes the run take longer.

**Assumed.** A Postgres transaction commits whole or not at all, and a dead worker's transaction rolls back. `select ... for update` and a conditional update both wait for the row lock. SMTP accepting the message means the customer has it: the check doesn't count on mail systems dropping duplicates by Message-ID. pg-boss works as version 12.38.0 does: a re-claim adds 1 to `retry_count`, a settle from an outdated attempt is ignored, and an expired job is retried or failed without calling `onGiveUp`. Retry delays and timeouts are left out, because only the order of steps matters to these promises.

**Left out.** Shadow mode and `planDelivery`, the raw file write, edits, notices and "fixed" notices, more than one draft per conversation, API access checks, tenant isolation, and eventual delivery. `NoSilentStall` is a safety stand-in for "it eventually goes out or a person is told".

## Known findings

- **Give-up failure.** On the last attempt, the worker dies (`worker_dies`) or handleSendGaveUp's transaction fails (`give_up_fails`). pg-boss fails the job without calling onGiveUp, or after it threw. The draft stays `approved` with no job left to send it, and nothing shows it (`NoSilentStall`).

- **Lost retry.** Both send attempts fail. The give-up transaction commits `send_failed`. Before pg-boss settles the job, `retrySend` commits `approved` and reuses that still-active job. pg-boss then marks the old job failed. Nothing sends the approved draft. This needs no injected fault beyond ordinary SMTP rejection.

## Evidence and maintenance

`apps/server/src/drafts/send-path-replay.int.test.ts` replays duplicate delivery, hidden delivery, give-up transaction failure and the lost-retry window against real Postgres, pg-boss and Mailpit. Run it with `pnpm --filter @helpos/server exec vitest run src/drafts/send-path-replay.int.test.ts`. The replay includes acceptance followed by an exception, an actual database COMMIT failure, and a killed child worker after Mailpit acceptance.

The model mutants check removed give-up handling, a give-up that overwrites `sent`, sending before validation, an absent marker recheck, and automatic admission of an uncertain draft. Both sides of each control/mutant pair disable person retries. A broken control fails the command even if that invariant is an accepted finding in another scenario. These controls protect the tested mutation conditions; accepted-finding scenarios still require trace review and do not distinguish every possible new failure. Run `pnpm verify:send-reply:mutations` from a clean source checkout to repeat the real-code proof. It runs the send-path safety assertions on normal code, temporarily applies four source mutations, requires all five intended assertions to fail, restores the source in `finally`, and reruns the assertions. It saves source backups, patches and logs under `.helpos/send-mutations/`. Do not run other tests or edits concurrently with this command. After a process termination, compare the source with Git and restore the saved backups before continuing. The generated skill still requires manual source-to-model review; fingerprint checks do not translate source into TLA+.


`NoResendWithoutPerson` bounds total accepted deliveries by one plus retry requests. A retry request that reuses an active job still grants this allowance. It does not prove a stronger per-request ordering guarantee. The one-retry bound covers both retry branches but is not an inductive proof for eight retries. Raising `MaxFaults` alone repeats the selected fault; combine entries in `Faults` to explore mixed failures.

Use `/maintain-formal-verification-skill` after covered changes that did not recheck this model. Keep findings separate from a successful runner exit: exit 0 means the expected findings were reproduced, not that all promises hold.
