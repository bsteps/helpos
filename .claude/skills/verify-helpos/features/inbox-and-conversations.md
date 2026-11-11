# Inbox and conversations

The inbox lists open conversations, newest activity first, with flags for anything that needs attention. A conversation page shows the whole conversation and its draft. Closing a conversation takes it out of the inbox.

## Sub-features

- `inbox-list` shows open conversations with customer, subject and time.
- `inbox-flags` shows `Reply not sent`, `AI paused` and `Automated` badges.
- `inbox-stats` shows the line `Last 14 days: N% of drafts approved unchanged (x of y)`.
- `inbox-empty` shows `Nothing open` when there is nothing to do.
- `conversation-view` shows the conversation. HTML mail shows in a sandboxed frame.
- `conversation-close` closes a conversation, which leaves the inbox.

## How to get to it (user POV)

- Dashboard `/` (heading `Inbox`), then click a conversation's subject link to reach `/conversations/<id>`. `Inbox` / `Back to the inbox` returns.
- API: `GET v1/conversations` (query `status=open|closed`, `orReplyNotSent=true`), `GET v1/conversations/{id}`, `POST v1/conversations/{id}/close`.

## Driving it with Playwright and api.mjs

Preconditions: baseline, signed in as owner.

- **List.** The `Inbox` heading shows a link per open conversation. `pnpm api northwind:triage-bot GET "v1/conversations?status=open"` returns the same subjects.
- **Open.** Click a subject link. The heading is the subject, and the conversation lists each message with sender and time. `pnpm api northwind:triage-bot GET v1/conversations/<id>` returns `messages[]`.
- **Close.** Deliver a fresh email (see inbound-email), open it, and click `Close conversation`. The status reads `Closed`, the button disappears, and back in the inbox the subject is gone. API: `pnpm api owner POST v1/conversations/<id>/close` returns `200`, and `GET v1/conversations/<id>` shows `status: "closed"`.
- **Scope.** `pnpm api northwind:approver-bot POST v1/conversations/<id>/close` returns `403 forbidden`, because closing needs `conversations:write` and `conversations:read`. A token minted with only `conversations:write` gets 403 too: the closed conversation it would get back shows the customer.
- **Isolation.** `pnpm api lumen:support-agent GET v1/conversations/<northwind conversation id>` returns `404 not_found`, not `403`, so another workspace can't even tell the conversation exists.
- **Stats line.** Seed drafts are dated January 2026, so the line counts only recent drafts. Freeze the browser clock at `2026-01-20T12:00:00Z` (`page.clock.setFixedTime`) to see `Last 14 days: 67% of drafts approved unchanged (2 of 3)`.

## Gotchas

- No seed agent token has `conversations:write`. Close as `owner`, or mint a token with `conversations:read` and `conversations:write`.
- Closing a seeded conversation changes what later checks see. Close a conversation you delivered yourself.
- The `orReplyNotSent=true` filter adds closed conversations whose reply failed to send, so a closed conversation can still be listed.
