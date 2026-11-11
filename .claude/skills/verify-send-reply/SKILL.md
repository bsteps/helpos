---
name: verify-send-reply
description: Model-checks the reply send path (approve, the send-reply job, SMTP, commit, pg-boss retries and give-up) with TLA+, against four promises, under worker crashes, lost SMTP replies, failed commits, expired job leases and a failed give-up. Use before you merge any change to a function in its coverage record, refactors, moves and renames included, when you work on #130 or the give-up/lost-retry finding, and when pg-boss is upgraded.
---

# Verify the send path

Handoff status: draft. Read [EVIDENCE.md](EVIDENCE.md) for the remaining real-code mutation and `/statechart` gates before treating this as a completed verification skill.

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

It runs one fault at a time, checking each promise, then runs each mutant in `model/mutants/`, a known break of the code that must make its promise fail. Exit 0 means two things: every result matches the expected table (the `runs` list in `scripts/check.mjs`, with known findings identified below), and every function in the coverage record matches its fingerprint. Each line starting `!!` says what is off and what to do. The TLC files for every result are in `.helpos/verify-send-reply/<run>/<promise>/`.

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
Last confirmed at commit `801b81e15e31`.

| Module | Function | Model steps | Fingerprint |
| --- | --- | --- | --- |
| apps/server/src/drafts/send-worker.ts | handleSendReply | WorkerLocksAndChecks, SmtpAccepts, SmtpRejects, SmtpReplyLost, TransactionCommits, TransactionCommitFails | `474b418223f2` |
| apps/server/src/drafts/send-worker.ts | handleSendGaveUp | GiveUpMarksFailed, GiveUpFails | `e1ea62598776` |
| apps/server/src/drafts/lifecycle.ts | draftTransitions | MarkSendFailedFrom, and the status guards of every Person action | `8fa462cc759f` |
| apps/server/src/drafts/lifecycle.ts | change | the conditional update and row lock every status change goes through | `b8bcb5acfa88` |
| apps/server/src/drafts/lifecycle.ts | queueSend | Enqueue | `1d94c013aa00` |
| apps/server/src/drafts/lifecycle.ts | approveDraft | PersonApproves | `cd185c05f0b3` |
| apps/server/src/drafts/lifecycle.ts | retrySend | PersonRetriesSend | `6b1c318536b9` |
| apps/server/src/drafts/lifecycle.ts | discardDraft | PersonDiscards | `c56a8fd6629c` |
| apps/server/src/drafts/lifecycle.ts | markSent | TransactionCommits | `7cf4398e8c1d` |
| apps/server/src/drafts/lifecycle.ts | markSendFailed | GiveUpMarksFailed | `66f5f6db3884` |
| apps/server/src/jobs.ts | jobs | send-reply worker registration | `72daa0e06a72` |
| apps/server/src/jobs.ts | defineJob | transaction wiring and give-up wrapper | `a99b2cee9f9e` |
| apps/server/src/jobs.ts | sendReplyRetry | RetryLimit | `29d5382a4c16` |
| packages/db/src/jobs.ts | APP_ENQUEUE_SQL | Enqueue (singleton key) | `1e14891501d5` |
| packages/db/src/jobs.ts | createJobRunner.consume | Fail: onGiveUp only on the last attempt, after the rollback | `2aeaf7d934eb` |
| packages/db/src/jobs.ts | createJobRunner.work | one transaction per attempt (`transaction`, not `steps`) | `20eda0869cc2` |
| pg-boss | version | WorkerClaimsJob, Settle (attempt fence), JobLeaseExpires | `12.38.0` |
<!-- /coverage -->

## Scope

**Checked.** One draft, from `pending` through approval, every send attempt and the give-up, with a person's retry and discard able to interleave. Two workers, so a slow attempt and its retry can overlap.

**Bounds.** One retry (the code has 8). Attempts past the first all take the same steps, and the model covers both the "retries left" and the "last attempt" branch. One person retry. One fault per run, at most once. Raise `MaxFaults` in `scripts/check.mjs` to look for bugs that need two faults. Each extra fault makes the run take longer.

**Assumed.** A Postgres transaction commits whole or not at all, and a dead worker's transaction rolls back. `select ... for update` and a conditional update both wait for the row lock. SMTP accepting the message means the customer has it: the check doesn't count on mail systems dropping duplicates by Message-ID. pg-boss works as version 12.38.0 does: a re-claim adds 1 to `retry_count`, a settle from an outdated attempt is ignored, and an expired job is retried or failed without calling `onGiveUp`. Retry delays and timeouts are left out, because only the order of steps matters to these promises.

**Left out.** Shadow mode and `planDelivery`, the raw file write, edits, notices and "fixed" notices, more than one draft per ticket, API access checks, tenant isolation, and eventual delivery. `NoSilentStall` is a safety stand-in for "it eventually goes out or a person is told".

## Known findings

- **#130.** SMTP accepts the reply, then the job's transaction fails to commit (`commit_fails`), SMTP's reply is lost (`smtp_reply_lost`), or the worker dies (`worker_dies`). The transaction rolls back, the draft is still `approved`, and pg-boss retries. The retry sends the reply again (`NoResendWithoutPerson`). Or the retry fails, and handleSendGaveUp marks the draft `send_failed` although the customer got it (`NoHiddenDelivery`).
- **Give-up failure.** On the last attempt, the worker dies (`worker_dies`) or handleSendGaveUp's transaction fails (`give_up_fails`). pg-boss fails the job without calling onGiveUp, or after it threw. The draft stays `approved` with no job left to send it, and nothing shows it (`NoSilentStall`).

- **Lost retry.** Both send attempts fail. The give-up transaction commits `send_failed`. Before pg-boss settles the job, `retrySend` commits `approved` and reuses that still-active job. pg-boss then marks the old job failed. Nothing sends the approved draft. This needs no injected fault beyond ordinary SMTP rejection.

## Evidence and maintenance

`apps/server/src/drafts/send-path-replay.int.test.ts` replays duplicate delivery, hidden delivery, give-up transaction failure and the lost-retry window against real Postgres, pg-boss and Mailpit. Run it with `pnpm --filter @helpos/server exec vitest run src/drafts/send-path-replay.int.test.ts`. The transport injects acceptance followed by an exception; this demonstrates rollback after external delivery, not a physical database COMMIT failure or process kill.

The model mutants check removed give-up handling, a give-up that overwrites `sent`, and sending outside the row-lock transaction. Mutant runs disable person retries so the existing lost-retry finding cannot make their checks pass accidentally. Scratch edits to the real give-up handler, transition table and row lock were rejected by the coverage guard, then restored. This proves drift detection; it does not prove that a source edit automatically changes the TLA+ model. A maintainer must still update the mapped actions and inspect their traces.

`NoResendWithoutPerson` bounds total accepted deliveries by one plus retry requests. A retry request that reuses an active job still grants this allowance. It does not prove a stronger per-request ordering guarantee. The one-retry bound covers both retry branches but is not an inductive proof for eight retries. Raising `MaxFaults` alone repeats the selected fault; combine entries in `Faults` to explore mixed failures.

Use `/maintain-formal-verification-skill` after covered changes that did not recheck this model. Keep findings separate from a successful runner exit: exit 0 means the expected findings were reproduced, not that all promises hold.
