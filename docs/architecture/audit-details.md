# Audit inputs

`recordAudit()` validates details against the action's strict Zod schema before
inserting the event in the action's transaction. Failed validation aborts the
transaction. The app role can insert and select audit rows, never update or delete
them. The existing tenant policy still applies to the new JSONB column.

## Body hashes

Draft events store lowercase SHA-256 hashes of the exact UTF-8 body, without
normalization. An edit records `oldBodyHash` and `newBodyHash`. Approval records
`reviewedBodyHash`. Creation records `bodyHash`, the answered `messageId`, and the
draft `kind`. These hashes allow comparison with a known body without copying
customer text into another table. They are not anonymization or proof that a
low-entropy body cannot be guessed. PII masking and retention remain #52 and #78.

## Discard reasons

- `manual` records the requested operation: `discard`, `regenerate`, or `replace` when
  a person or agent writes a new draft for the same message.
- `superseded` records the newer incoming `newerMessageId`.
- `issue_reopened` records automatic withdrawal of a pending fixed notice.

A replacement on the same message must not claim that a newer message arrived.
Nested events retain the supplied actor, tenant and request ID.

## Other actions and history

Send events record the status transition. A retry distinguishes a failed-send
retry, an approved-send requeue, and a person requesting another send after
uncertain delivery. Notice events identify the pending draft. A notice-sent event
records the attempt under the existing notice transaction, not a receipt from
every owner.

Actions outside drafts accept an empty details object. Strict schemas reject extra
fields, including body text.

Migration `0024_audit-details.sql` adds a nullable column without a backfill or
default. `NULL` means legacy details are unavailable. It does not mean an empty
body, a manual discard, or any other reconstructed input. New events written
through `recordAudit()` store validated objects. Old events and raw historical
fixtures keep `NULL`. No historical event is rewritten.

The demo seed stores details only when its scenarios retain the exact inputs.
Token events use empty objects. Unedited creation, approval, and send events retain
known hashes or transitions. Creation before an edit, intermediate edit bodies,
and the historical discard reason remain `NULL` because those inputs are unavailable.
