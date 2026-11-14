---
name: verify-gate
description: Model-checks the gate's claim-and-approval protocol (expiring claims with a fencing epoch, conversation versions, proposals, review, approval, execution, lost outcomes and person resends) with TLA+, against five promises from threat-model rules G4 to G7. Use before set A changes claims, conversation versions, stale marking, approvals, the send worker's approval check, or who may approve, and when you work on #165, #189 or #13.
---

# Verify the gate

Agents propose, and people approve. This check explores every order of steps in a small model of that protocol, and checks five promises in each state. Two agents race for one conversation, a person can take over at any time, the customer can write while an agent thinks, claims expire on the clock, and something outside the lifecycle can change a stored action after approval.

| Promise | In the model | Rule | Harm when it breaks |
| --- | --- | --- | --- |
| Every accepted or edited proposal came from the actor holding the live claim at that moment, and no agent takes a claim someone holds live. | `OneWriter` | `G6`, #165 | Two writers act on one conversation, or an agent overrides the person who took over. |
| No proposal is accepted or approved while based on an older conversation version. | `LatestVersionOnly` | `G6`, #165 | A person approves an answer to a question the customer has moved past. |
| What ran is exactly what was approved, and what was approved is exactly what the approver reviewed. | `ApprovedMeansThatAction` | `G5`, #189 | An action nobody approved runs under someone's approval. |
| An action takes effect at most once per approval plus person resends. | `NoAutomaticResend` | `G7` | The customer gets the same email twice, or a refund is paid twice. |
| Every approval was made by a person. | `OnlyPeopleApprove` | `G4`, #13 | An agent approves its own proposal, so the gate stops nothing. |

`TypeOK` is checked with every run. It only says each variable holds a value of the right kind.

## When you must run it

- Any change to how a conversation is claimed, renewed, taken over or released, or to the conversation version (#165).
- Any change to what marks a waiting proposal out of date, to `createReply`, or to `approveDraft` and its reviewed-body check.
- Any change to the send worker's check before it acts, including the hash check at execution (#189), and to `send_uncertain` or `resolveUncertainSend`.
- Any change to who may approve or resolve. That covers the `access` of approve-class routes, `humansOnly`, and which scopes an agent token can hold (#13).

## Run

```bash
pnpm verify:gate
```

It needs Java 11 or newer on PATH. The first run downloads TLC 1.7.4 (pinned by SHA-256) into `.helpos/tools/`, the same jar `pnpm verify:send-reply` uses. A full run takes about 10 seconds.

It runs the base model once with every promise, then each mutant in `model/mutants/` with only the promise its header names. Each line starting `ok` matches what is expected. The base model must hold everything, and every mutant must break its promise. Exit 0 means every line is `ok`. A line starting `!!` says what is off and what to do. For a broken run, the line under it lists the shortest path to the broken state, as action names. The TLC files for every run are in `.helpos/verify-gate/<run>/`.

`node --test .claude/skills/verify-gate/scripts/check.test.mjs` tests the checker itself, and `pnpm test:scripts` runs it in CI. It runs the real checker on a scratch copy, requires every mutant to break its promise, then makes `SubmitGuard` always true and requires the run to fail. It skips when Java is missing, except under `CI`, where it fails.

## Read every result with `/statechart`

For any broken promise, read its folder with the pstack `/statechart` skill (where you can't start it yourself, read its `SKILL.md` and follow it). It tells the shortest path to the broken state in plain words. When everything holds, it draws how a proposal moves between states. Then decide:

- **A real bug** replays on the real code. Replay the path one step at a time, using the table below to find the code for each step, as a race test in `apps/server/src/gate-promises.int.test.ts` against real Postgres. Report it with the path in the code's words. Never weaken a promise to make it pass.
- **A modeling error** doesn't replay. Find the first step where the model and the code differ. Usually one model step is split by an `await` in the code, the model lacks a guard the code has, or the model has a guard the code lacks. Fix the model and say in the PR what was wrong.

## Changing the model

When a change to the protocol is intended, change the model to match before you trust a pass.

1. Edit the actions in `model/Gate.tla` that the table below maps the changed code to. What the code does in one transaction or one conditional update is one action in the model, and nothing more.
2. Keep the promises as they are.
3. Every guard lives in its own operator (`ClaimGuard`, `EditGuard`, `SubmitGuard`, `ApproveGuard`, `ExecuteGuard`, `OnCustomerMessage`, `Approvers`, `AfterLostOutcome`). A new guard gets its own operator and a mutant in `model/mutants/`. A mutant file replaces whole operators, its first comment line says what it breaks in the code's words, and its `\* breaks:` line names the promise that must fail.
4. If a mutant stops breaking its promise, the model is wrong or too tightly bounded. Fix the model, never the mutant or the promise.
5. Rerun.

## Where each step lives

The claim steps describe set A's design, and no code does them yet. So this skill has no coverage record yet. The issue that builds each step adds rows for its functions, with fingerprints and the commit, in the pattern of the coverage record in `.claude/skills/verify-send-reply/SKILL.md`.

| Model step | Code today, or the issue that builds it |
| --- | --- |
| `Tick` | The injected `Clock` in `apps/server/src/services.ts`. Claims expire by it once #165 builds them. |
| `CustomerWrites`, `OnCustomerMessage` | `ingestEmail` in `apps/server/src/inbound-email/ingest.ts` stores the message. The version and marking waiting proposals out of date are #165. Today nothing marks a pending draft when the customer writes, so today's code behaves like the mutant `customer-message-keeps-pending` until the next draft is saved. |
| `Claim`, `ClaimGuard`, `PersonTakesOver`, `Renew` | #165. No code yet. |
| `AgentReads` | The draft worker reads the conversation before its AI call (`apps/server/src/drafts/draft-worker.ts`). Recording the claim epoch and the version it read is #165. |
| `AgentSubmits`, `SubmitGuard` | `createReply` in `apps/server/src/drafts/lifecycle.ts` saves the proposal and replaces older pending ones, under `lockConversationForDrafting`. The draft worker's `save` checks that the message it answered is still the latest. The claim and version check is #165. |
| `AgentEdits`, `EditGuard` | `editDraft` in `apps/server/src/drafts/lifecycle.ts`, while the draft is `pending`. Requiring the claim is #165. |
| `Review`, `Approve`, `ApproveGuard` | `approveDraft` in `apps/server/src/drafts/lifecycle.ts` approves only if the stored body equals the reviewed body. Recording a signed approval of the exact action is #189. |
| `Approvers` | The `access` of approve-class routes in `apps/server/src/drafts/routes.ts`, checked by `apiRoute()` in `apps/server/src/auth/access.ts`. `humansOnly` refuses agent tokens. Today the approve route needs `drafts:approve` but is not `humansOnly`, so today's code behaves like the mutant `agents-approve`. Making every approve-class route human-only is #13. The route table in `apps/server/src/auth/access.test.ts` checks it. |
| `Tamper` | Any write to a stored action outside the lifecycle, such as a direct SQL update. |
| `Execute`, `ExecuteGuard`, `ExecuteRefuses` | `handleSendReply` in `apps/server/src/drafts/send-worker.ts`. Today it checks the status, not the action. Checking the action against the approved hash, and refusing when they differ, is #189. |
| `ExecuteOutcomeLost`, `AfterLostOutcome` | `handleSendReply` marks the draft `send_uncertain` before SMTP, so a lost result leaves it there. `pnpm verify:send-reply` checks that path in detail. |
| `PersonResends`, `PersonConfirms` | `resolveUncertainSend` in `apps/server/src/drafts/lifecycle.ts`, through the `humansOnly` route `drafts.resolveSend`. |

## Scope

**Checked.** One conversation, every order of the steps above, with two agents, one person and two possible actions (`x` and `y`).

**Bounds.** The clock runs from 0 to 2, and a claim lasts 2 ticks (`MaxTime = 2`, `ClaimTTL = 2`). Two claims in all, so an agent's claim can be followed by a takeover or by another agent's claim after expiry, but not both (`MaxClaims = 2`). One customer message (`MaxMessages = 1`). Two accepted proposals, so a newer one can replace a pending one (`MaxProposals = 2`). One tamper and one person resend per proposal (`MaxTampers = 1`, `MaxResends = 1`). The constants are in `scripts/check.mjs`. The base run has about 780,000 states. Raising `MaxClaims` to 3 more than doubles it.

`Renew` adds no state at these bounds. A renewed claim looks the same as a claim taken later, because nothing in the model records when an agent read. It is in the model so a change to renewal has a place to go.

**Assumed.** A claim is one conditional update in Postgres, so two claims at once leave one owner. A submit checks its guard and inserts the proposal in one conditional write, and approval does the same. The clock only moves forward, and every check reads the same clock. An effect whose outcome is lost may or may not have happened.

**Left out.** Caps, the kill switch, trust and promotions, permissions per action type, proposals written by people, more than one conversation, tenant isolation, and liveness, such as whether an approved action ever runs. A customer message after approval doesn't stop the approved action. The promises cover acceptance and approval only.
