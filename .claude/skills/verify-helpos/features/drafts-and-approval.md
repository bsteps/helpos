# Drafts and approval

For every new customer email, the AI writes a reply draft that cites the knowledge it used. Nothing reaches a customer until a human or an agent with `drafts:approve` approves it. Approving queues the send. The worker sends it threaded, and the draft becomes `sent`. A send that keeps failing becomes `send_failed`, and can be retried or discarded.

Draft states: `pending` → `approved` → `sent`, or `discarded`, or `send_failed` (→ retry → `approved`).

## Sub-features

- `draft-ai` writes a `pending` draft for a new email, with `sources` and the `Written from` list.
- `draft-edit` changes the text before approval. An agent's edit is audit-logged.
- `draft-approve` approves exactly the text that was reviewed. If the text changed meanwhile, the approval is refused (409).
- `draft-send` makes the worker send to the shadow recipient, then marks the draft `sent`.
- `draft-discard` drops a pending or failed draft.
- `draft-retry` re-queues a `send_failed` draft with the same Message-ID.
- `draft-new` writes your own reply, or asks the AI for a new one (`regenerate`).
- `draft-internal` warns when the draft was written with, or quotes, an internal note.

## How to get to it (user POV)

- Dashboard ticket page: the card `AI draft` with buttons `Edit` (then textbox `Reply` and `Save`/`Cancel`) and `Approve & send`. No `Discard` on a pending draft. When sending failed for good: `send-failed-alert` with `Retry send` / `Discard`, then `Write a new draft`.
- API: `GET v1/tickets/{id}/drafts`, `PATCH v1/drafts/{id}` `{"body"}`, `POST v1/drafts/{id}/approve` `{"body": <the text you reviewed>}`, `POST v1/drafts/{id}/discard`, `POST v1/drafts/{id}/retry`, `POST v1/tickets/{id}/drafts` `{"body"}` or `{"regenerate": true}`.

## Driving it with Playwright and api.mjs

Preconditions: baseline. AI configured. Embeddings on, for `sources`.

- **Whole loop, scripted.** `pnpm app:journey --via web` and `--via api`. Both must print `PASS`. Evidence is in `.helpos/verify/<ts>-reply-<via>/`.
- **AI draft.** After delivering an email, `pnpm api northwind:triage-bot GET v1/tickets/<id>/drafts` shows one `pending` `reply` with a non-empty `sources[]`. The ticket page shows it in `draft-body` with `Waiting for approval` and `Written from <source title>`.
- **Edit.** Click `Edit`, fill textbox `Reply`, and click `Save`. `draft-body` shows the new text. API: `pnpm api northwind:triage-bot PATCH v1/drafts/<draftId> '{"body":"New text"}'` returns `200`, and a second GET shows it.
- **Stale approve.** Open the ticket page, then change the draft over the API, then click `Approve & send`. The page says `This draft changed since you opened it`, shows the new text, and nothing is sent. API: approving with an old `body` returns `409 not_pending`, the same answer as for a draft that is no longer pending.
- **Approve and send.** One command: `pnpm approve-draft new` (or a ticket ID). By hand: `pnpm api northwind:approver-bot POST v1/drafts/<draftId>/approve '{"body":"<current body>"}'` returns `200` with `status: "approved"`. The draft is `sent` within seconds. Mailpit has `Re: <subject>` addressed to the owner (shadow recipient) and not to the customer. In the dashboard, the badge reads `Sent`.
- **Discard.** A pending draft is discarded through the API only: `pnpm api northwind:triage-bot POST v1/drafts/<draftId>/discard` returns `200` with `discarded`, and nothing is sent. The dashboard's `Discard` button exists only on a `send_failed` draft, next to `Retry send`.
- **New draft.** `pnpm api northwind:triage-bot POST v1/tickets/<id>/drafts '{"regenerate":true}'` returns `202 queued`, and a new `pending` draft appears. `'{"body":"My own reply"}'` creates one with that text.
- **Internal note.** Deliver an email whose text matches the seeded internal source "Refund exceptions (internal)". The draft has `internalKnowledge: true`. When it repeats the note word for word, `quotesInternalNote: true` and the page shows `This draft quotes an internal note`.
- **Scopes.** `pnpm api northwind:triage-bot POST v1/drafts/<id>/approve ...` returns `403`, because writing a draft isn't approving it. `pnpm api northwind:approver-bot PATCH v1/drafts/<id> ...` also returns `403`.

## Gotchas

- `approve` needs the exact current `body`, so read it first. This is deliberate, not a bug.
- A new pending draft queues an owner notice email 5 minutes later (`HELPOS_NOTICE_DELAY_SECONDS`) unless it's approved first. Don't mistake that notice for the reply in Mailpit. Match `Re: <subject>`.
- Locally you can't make a send fail for good in reasonable time: it retries for about 3 hours. The `send_failed` / `Retry send` / `Write a new draft` path is proven by the e2e suite (`apps/web/e2e/send-failed.spec.ts`, fake SMTP). Report it as not driven when you can't reach it.
- `ticket.automated` tickets and tickets paused by the AI budget (`AI paused`) never get a draft. That is correct behavior, not a failure.
- Drafts use the real model: wording varies between runs. Assert states, sources and recipients, not exact text.
