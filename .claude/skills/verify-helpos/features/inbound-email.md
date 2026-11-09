# Inbound email

An email provider posts each raw email to HelpOS. The address it was sent to picks the workspace. A new conversation becomes a ticket, a reply joins its ticket, and the content is stored as data, never acted on. Bounces and out-of-office replies are stored but marked automated, and get no AI draft.

## Sub-features

- `inbound-new` turns a new email into a ticket with a customer and a message, and queues an AI draft.
- `inbound-thread` puts a reply (In-Reply-To / References) on its existing ticket.
- `inbound-duplicate` stores the same Message-ID once.
- `inbound-automated` marks bounces, out-of-office and mailing-list mail as `automated`, with no draft.
- `inbound-reject` returns 401 for a wrong secret, 404 for an unknown mailbox, 413 for too large.
- `inbound-html` stores HTML mail and returns it sanitised. Attachments are stored as files.

## How to get to it (user POV)

- An email provider or relay: `POST v1/inbound/email`, `Authorization: Bearer <HELPOS_INBOUND_SECRET>`, body is the raw MIME (`message/rfc822`).
- Locally: `pnpm dev:send-email <file.eml>`, or `$A inbound POST v1/inbound/email @<file.eml>`.
- The result is visible in the dashboard inbox and through `GET v1/tickets`.

## Driving it with Playwright and api.mjs

Preconditions: baseline. Fixtures are in `fixtures/email/`.

- **New ticket.** `$A inbound POST v1/inbound/email @fixtures/email/plain.eml` returns `201` with `status: "created"`, a `ticketId` and a `messageId`. `$A owner GET v1/tickets/<ticketId>` shows the subject, the customer and one inbound message. Within about 30 seconds `GET v1/tickets/<ticketId>/drafts` has a `pending` draft.
- **Duplicate.** Post the same file again. The answer is `200` with the same `ticketId`, and no second message appears.
- **Thread.** Post `@fixtures/email/reply.eml`. It joins the ticket of the email it answers (when that one is stored) instead of making a new one.
- **Automated.** Post `@fixtures/email/bounce.eml` and `@fixtures/email/out-of-office.eml`. The ticket has `automated: true`, the inbox row shows `Automated`, and no draft is ever written.
- **HTML and XSS.** Post `@fixtures/email/xss.eml`, then open the ticket in the dashboard. The HTML shows inside a sandboxed frame, and no script runs (no dialog, nothing in the console). The API `html` field has no `<script>`.
- **Attachment.** Post `@fixtures/email/attachment.eml`. The ticket's message lists the attachment.
- **Prompt injection.** Post `@fixtures/email/prompt-injection.eml`. The draft answers the customer and does not obey the email's instructions.
- **Rejections.** `$A none POST v1/inbound/email @fixtures/email/plain.eml` returns `401`. `@fixtures/email/unknown-mailbox.eml` returns `404 unknown_mailbox`, and nothing is stored.

## Gotchas

- Most fixtures are addressed to `support@acme.test`. `api.mjs inbound` swaps that address for the Northwind mailbox, but `pnpm dev:send-email` does not, so it gets `404` unless an Acme workspace exists.
- Fixtures have fixed Message-IDs, so a second run of the same fixture is a duplicate (`200`), not a new ticket. To get a fresh ticket, change the `Message-ID` and `Subject` lines, or use `journey-reply.mjs`.
- The draft comes from the real model in `.env`. If the AI is not configured, draft jobs wait in the queue and the ticket shows `The AI is writing a draft…` indefinitely.
