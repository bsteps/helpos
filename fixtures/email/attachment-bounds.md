# Inbound attachment bounds

Run `node scripts/generate-attachment-limit.mjs` to regenerate
`attachment-limit.eml`. It contains 21 attachments, one more than the storage
cap, and a filename longer than the 255 Unicode code point limit.

Inbound mail stores the first 20 attachments in MIME order. Inline attachments
count too. Filenames are truncated after NUL removal without splitting Unicode
code points. Missing names stay missing. Storage keys remain generated IDs.
Twenty allows a support report with multiple screenshots and logs while limiting
each message to 20 attachment row inserts and 21 file writes including raw MIME.
The filename limit keeps display metadata modest; it is not a filesystem byte
limit because these names are never used as paths. Truncation can remove an
extension or make display names equal; storage keys remain distinct.

Excess attachments are not stored separately. A note with the omitted count is
shown above a plain-text rendering of the message. Only overflowing mail loses
HTML formatting. The shared visible-text extractor excludes hidden text and
preserves the existing fallback for blank text alternatives. This avoids HTML
document boundaries or unclosed hidden tags swallowing the system note. The original MIME,
including omitted parts and original filenames, remains in the raw file store.
There is currently no public attachment download API. This is not lossless
attachment access for users.

Postal MIME 4.2.0 source defaults to 10,000 MIME parts, 2 MiB of cumulative
headers, MIME depth 256, inline forwarded-message depth 10, and 10,000 forwarded
addresses. It has no dedicated filename length cap. These parser limits remain
unchanged. The storage cap applies after parsing and does not claim to reduce
parser work or memory; the existing inbound HTTP body limit is 10 MiB.

`attachment-bounds.int.test.ts` posts the generated fixture through the public
inbound route against real Postgres and a local disk file store. It checks the
stored rows, exact file-write count, retained bytes, visible conversation API
note, and duplicate delivery. Additional cases cover the exact cap, HTML-only
hidden content, and Unicode filenames. No schema or migration changes are needed.
