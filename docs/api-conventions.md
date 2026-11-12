# API conventions

## Errors and request IDs

Errors use `application/problem+json`, following [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html).
Every error includes `type: "about:blank"`, the HTTP status title, `status`, and an `instance` URI tied to the request ID.
The existing `error` code and safe extensions such as `sourceId` remain available.
Framework validation errors become `bad_request` without input values or internal error messages.
The server's `errorCodes` list defines the public codes and the OpenAPI `Error.error` enum.
Route handlers and middleware emit codes through the typed `errorResponse()` builder.
Unknown framework or provider error bodies become `bad_request` with their HTTP status retained.
Known codes retain their safe extensions. Knowledge-source ingestion failure reasons are a separate field, not HTTP error codes.
The dashboard derives `ErrorCode` from its generated client and checks an exhaustive common message map plus contextual overrides.
Successful JSON responses keep `application/json`.

Every response returns `X-Request-Id`. Completion logs and unexpected-error logs carry that same ID.
An accepted incoming request ID is retained. Otherwise the server generates one.
Request logs contain the method, path and status, without query strings, credentials or bodies.

## Liveness and readiness

`GET /health` returns `200 {"status":"ok"}` when the HTTP process can answer, without querying dependencies.
This replaces the former combined database check and its `database` response field.
`GET /readyz` returns `200 {"status":"ok"}` only when the app database answers and the jobs role can read every registered queue through pg-boss.
Otherwise it returns `503 not_ready`. Dependency details appear only in logs.
Readiness checks queue availability, not worker progress, SMTP delivery or model availability.

## Idempotent writes

Authenticated POST, PUT, PATCH and DELETE routes accept an optional `Idempotency-Key` header.
Requests without it retain their existing behavior.
A key is 1 to 200 visible ASCII characters without spaces.
The server stores its SHA-256 hash, scoped by tenant, actor type and actor ID.
Each agent token is a separate actor. Human sessions for the same user share that user's keys within a workspace.

The fingerprint includes the method, exact path and query string, content type, exact body bytes and current scope set.
Reusing a key with a different fingerprint returns `409 idempotency_conflict` before the handler runs.
JSON whitespace and query ordering therefore matter.
Authentication and the route's current access rule run before every reservation or replay.
A revoked token receives `401`, even when it previously completed a keyed request.
A changed scope set cannot retrieve the old response.

The database commits a reservation before admitting the handler.
A unique constraint permits only one admission for the tenant, actor and key, including across processes.
The handler retains its own transactions and transactional audit events.
The middleware stores its response only after the handler and audit checks finish.
A duplicate while that outcome is unresolved receives `409 idempotency_pending`.
Completed JSON responses with 2xx or 4xx statuses replay for 24 hours from reservation, including terminal validation errors and empty 204 responses.
Replay returns `Idempotency-Replayed: true` and a fresh request ID, and records no second action or audit event.
Problem details are rendered with the replay request's ID.

The reservation, action and response are separate transactions.
A crash before the handler runs can therefore consume a key without performing the action.
A crash after a committed action, an exception, a 5xx, or failure to store its response leaves the key unresolved.
No automatic retry of that key runs the handler again.
This is an at-most-once admission guarantee for a supplied key, not exactly-once completion or delivery.
An approval response confirms the API action, never SMTP delivery.
Unknown send outcomes still require the existing human resolution flow.

After 24 hours, the key returns `409 idempotency_expired` and never executes again.
The next access clears its response body but keeps the reservation as a tombstone.
There is no automatic tombstone deletion or background response purge in this issue.
Unaccessed response bodies remain stored under tenant RLS until operational retention work removes them.
When an outcome is unknown, reconcile the resource through the API before deciding on a new action.
A new key is a new request and can repeat an effect.

Credential-producing routes refuse keyed requests with `400 idempotency_not_supported` before validation or side effects.
These are `POST /v1/tokens`, `PUT /v1/integrations/github`, and `POST /v1/integrations/github/webhook-secret`.
Authentication and provider routes without a tenant principal also refuse the header.
Their existing credential or signature checks can refuse the request first.
No token, session cookie, webhook secret or request body is stored for replay.
Response headers are not cached. Replay reconstructs the JSON content type and replay indicator.

## Cursor helper

`paginationQuery` validates a limit from 1 to 100, defaulting to 50, and an optional base64url cursor.
The cursor contains a timestamp and UUID, both validated before use.
`cursorPage` takes `limit + 1` rows ordered by `created_at DESC, id DESC` and returns `items` and `nextCursor`.
A follow-up query selects timestamps older than the cursor, or smaller IDs at the same timestamp.
The tenant and any resource filters still apply to every query. A cursor grants no access.
The helper does not promise a snapshot across concurrent edits.
Existing list response fields and ordering remain unchanged. Their consumer migration belongs to #233.

## OpenAPI contract

Every documented operation has an explicit, nonempty `operationId`, required by `apiRoute()`.
These IDs are public contract names for clients and future agent tools.
They name capabilities in `area.action` form, such as `knowledge.createSource`, `drafts.approve`, and `auth.signIn`.
Liveness and readiness use `health.checkLiveness` and `health.checkReadiness`.
An operation keeps its ID when its method or path changes without changing its capability.
IDs are not derived from HTTP methods or paths. Renaming an ID is a breaking contract change.

The checked-in contract is `apps/web/src/api/openapi.json`.
`pnpm --filter @helpos/web gen:api` regenerates it and the dashboard types.
`apps/server/src/openapi.test.ts` compares it with the served document during the server tests in `pnpm verify`.
It also checks every operation in both documents for nonempty, unique IDs, including health, readiness, and authentication.
A stale contract or a missing, empty, or duplicate ID fails verification.

## Validate responses and compatibility

Server tests install `src/testing/setup.ts` through Vitest. It wraps the real `createApp()` with
`contractApp()`, including apps built by `composeServer()`. Existing request helpers keep their
response bodies because validation reads a clone. Standalone integration apps must use
`contractApp()` too. Pure domain tests do not need an app or a contract.

The boundary reads the app's live OpenAPI registry, including test-only routes. It uses Hono's
matched route and request method, then checks the declared status, media type and response schema.
AJV 2020 validates local schema refs, composition and formats without coercion or removal of fields.
Text responses validate as strings. HEAD, 204, 304 and responses without content must be empty.
Undocumented test routes, ambiguous overlapping paths, missing statuses, unsupported external refs
and unexpected media types fail. Register test probe contracts explicitly.
Unmatched requests must return the standard 404 problem. `/openapi.json` must return a 3.1 document.
These two infrastructure responses have explicit test contracts rather than bypasses.

The required CI check also runs `node scripts/api-compatibility.mjs --event "$GITHUB_EVENT_PATH"`.
It reads the actual pull request base SHA from the event, loads that commit's checked-in spec,
and compares it with a freshly generated current document. It never defaults to `main`.
To reproduce locally, run `node scripts/api-compatibility.mjs <actual-base-commit-or-ref> [pr-body-file]`.
Freshness tests still run independently.

The compatibility check uses oasdiff 1.37.0, an Apache-2.0 tool. It downloads the upstream release
archive for Linux or Windows x64 and verifies a pinned SHA-256 before extraction.
The test-only AJV and ajv-formats dependencies use MIT licences.
The complete breaking report stays in the CI log and `.helpos/api-breaking.json`, including
when an exception permits the check to pass. Tool errors and invalid specs always fail.

An intended breaking PR must contain exactly one line in its body in this form:

```text
API-Break: <affected operations, concrete reason, and how consumers must migrate>
```

Replace the placeholder with a justification of at least 20 characters. A quoted line or a mention
inside a paragraph does not mark a break. This marker covers the PR's reported changes, so review
every finding against the justification. Body edits rerun CI. The marker grants no merge authority
and does not remove `needs-human` for a public contract decision.

The response checks exposed a declaration bug in the shared `json()` helper. A knowledge source's
nullable ingestion `error` is resource data, not a typed API problem. Creation, editing and re-ingest
already return `application/json`; their declarations now describe that behavior without problem
fields. Conversation-list query validation now also declares its existing 400 problem response.
