# Inbox and tickets

The inbox lists open tickets, newest activity first, with flags for anything that needs attention. A ticket page shows the whole conversation and its draft. Closing a ticket takes it out of the inbox.

## Sub-features

- `inbox-list` shows open tickets with customer, subject and time.
- `inbox-flags` shows `Reply not sent`, `AI paused` and `Automated` badges.
- `inbox-stats` shows the line `Last 14 days: N% of drafts approved unchanged (x of y)`.
- `inbox-empty` shows `Nothing open` when there is nothing to do.
- `ticket-view` shows the conversation. HTML mail shows in a sandboxed frame.
- `ticket-close` closes a ticket, which leaves the inbox.

## How to get to it (user POV)

- Dashboard `/` (heading `Inbox`), then click a ticket's subject link to reach `/tickets/<id>`. `Inbox` / `Back to the inbox` returns.
- API: `GET v1/tickets` (query `status=open|closed`, `orReplyNotSent=true`), `GET v1/tickets/{id}`, `POST v1/tickets/{id}/close`.

## Driving it with Playwright and api.mjs

Preconditions: baseline, signed in as owner.

- **List.** The `Inbox` heading shows a link per open ticket. `$A northwind:triage-bot GET "v1/tickets?status=open"` returns the same subjects.
- **Open.** Click a subject link. The heading is the subject, and the conversation lists each message with sender and time. `$A northwind:triage-bot GET v1/tickets/<id>` returns `messages[]`.
- **Close.** Deliver a fresh email (see inbound-email), open it, and click `Close ticket`. The status reads `Closed`, the button disappears, and back in the inbox the subject is gone. API: `$A owner POST v1/tickets/<id>/close` returns `200`, and `GET v1/tickets/<id>` shows `status: "closed"`.
- **Scope.** `$A northwind:approver-bot POST v1/tickets/<id>/close` returns `403 forbidden`, because closing needs `tickets:write`.
- **Isolation.** `$A lumen:support-agent GET v1/tickets/<northwind ticket id>` returns `404 not_found`, not `403`, so another workspace can't even tell the ticket exists.
- **Stats line.** Seed drafts are dated January 2026, so the line counts only recent drafts. Freeze the browser clock at `2026-01-20T12:00:00Z` (`page.clock.setFixedTime`) to see `Last 14 days: 67% of drafts approved unchanged (2 of 3)`.

## Gotchas

- No seed agent token has `tickets:write`. Close as `owner`, or mint a token with it.
- Closing a seeded ticket changes what later checks see. Close a ticket you delivered yourself.
- The `orReplyNotSent=true` filter adds closed tickets whose reply failed to send, so a closed ticket can still be listed.
