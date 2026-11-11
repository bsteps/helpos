# Issue 208 email fixtures

`email-fixtures-208.int.test.ts` posts these MIME files to the inbound route against real Postgres. It checks decoded fields, conversation identity, raw storage bytes and forwarded attachment bytes.

The outbound case creates and approves a fixture draft through the API, invokes the send worker in a tenant transaction, and delivers through the SMTP transport to an isolated Mailpit container. It checks the envelope, encoded MIME, stored outbound message, delivered content and both customer follow-up headers. No model runs. The test uses synthetic `.test` recipients only.

The encoding fixtures deliberately use quoted-printable octets for ISO-8859-1 and Windows-1252. The HTML-only fixture has no text part. `forwarded-inner.eml` is the exact expected attachment, not another inbound delivery. The outbound subject comes from `outbound-source.eml` and the approved body from `reply.txt`.

## Missing Message-ID

The current provider route accepts raw MIME without a provider delivery identifier. A retry without Message-ID is indistinguishable from a legitimate second identical email. Both deliveries remain accepted as separate messages and conversations. The test preserves that existing behavior. Content hashing would drop legitimate messages and is deliberately not used. A provider that needs retry deduplication must preserve Message-ID. Adding a provider delivery-key contract is outside this fixture change.

## Limits

The send worker runs directly after API approval. This test proves MIME, transport and threading, not pg-boss scheduling or crash safety. The formal send-reply checks retain their known #130, give-up and lost-retry findings. No model fingerprints or production functions change here.
