# 0009. Tenant isolation beyond tenant tables: auth, jobs, realtime, vectors

- Status: Accepted
- Date: 2026-11-06
- Extends: ADR 0003 (does not replace any part of it)

## Context

ADR 0003 protects tables that have a `tenant_id`, and only when code runs inside `withTenant()`. Review found paths it doesn't cover:

- Better Auth tables (`users`, sessions) span tenants, so a single-tenant RLS policy can't protect them.
- pg-boss jobs run outside any HTTP request, so nothing sets `app.tenant_id` for them automatically.
- pgvector's HNSW index ignores RLS while it searches. RLS filters rows only after the index returns its top results, so a small tenant can get few or no matches.
- LISTEN/NOTIFY, views, `SECURITY DEFINER` functions and unique constraints can all show data, or the fact that data exists, without a normal `SELECT`.

All of these must be decided before the first tenant table lands in #44.

## Decision

Each item names the test that proves it. "Leak suite" means the cross-tenant suite from ADR 0003 (tenants A and B, acting as A).

### 1. Better Auth tables

- `users`, `sessions`, `accounts` and `verifications` have no `tenant_id` and no RLS. The app role **can't read or write them directly**. They're owned by a separate `auth` role and live in their own `auth` schema.
- Better Auth's Drizzle adapter runs on a dedicated client that connects as the `auth` role. That client lives in the auth module in `packages/db` and isn't exported. The rest of the app only gets narrow functions from it (sign in, resolve the current session to a user ID).
- `memberships` **is** a tenant table (RLS on `tenant_id`). After a session is resolved, the request needs a membership row for the requested tenant, read inside `withTenant()`. Without one it gets a `404`, not a `403`, so it can't tell whether the workspace exists.
- The workspace switcher must list a user's memberships across tenants, which tenant RLS can't do. A second policy on `memberships` allows `SELECT` when `user_id = current_setting('app.user_id')::uuid`, set transaction-locally the same way as `app.tenant_id`. It allows only reads of your own rows, never writes, and no role gets `BYPASSRLS`.
- Test: `leak: auth tables are not readable by the app role`, `leak: memberships lists only my own rows across tenants` and `leak: session of user in A cannot open tenant B` (#44 for the session check, #11 for full Better Auth).

### 2. pg-boss job payloads and workers

- Every tenant job payload is validated by a Zod schema that **requires** `tenantId`. A shared `enqueue()` helper is the only way to send a job, and it refuses a payload without one.
- A worker handler never receives a database client. The job runner calls `withTenant(job.tenantId, (tx) => handler(job, tx))`, so the handler can only see that tenant's rows.
- Payloads carry **IDs only**, never message bodies, email addresses or other tenant content. The handler reloads the data inside `withTenant()`. That also keeps data that's later deleted from lingering in job history.
- System jobs (with no tenant, e.g. cleanup) use a separate queue name prefix (`system.`) and a handler type that gets no tenant client.
- Test: `leak: job for tenant A cannot read tenant B rows` and `enqueue rejects a tenant job without tenantId` (#44).

### 3. pg-boss's own tables

- pg-boss's schema (`pgboss`) is owned by the pg-boss maintenance role from ADR 0003 (named `jobs`). The app role and the `auth` role have **no privileges** on it. The one exception is enqueueing, through a single function, `app_enqueue(queue, payload, options)`:
  - It's `SECURITY DEFINER`, owned by the `jobs` role, with `search_path` pinned. It's the first entry in the section 6 allowlist.
  - The app role gets `EXECUTE` on it, and nothing on the pg-boss tables. A plain `INSERT` grant isn't enough: pg-boss enqueues with `INSERT … ON CONFLICT … RETURNING id` for singleton and dedupe keys, and those clauses need `SELECT`, which would let the app read every tenant's jobs.
  - It accepts only the options `enqueue()` uses (singleton key, start time, retries) and returns the job ID. It never returns other rows. It prefixes every singleton key with the payload's `tenantId`, so tenant A can never dedupe against, or learn the ID of, a job from tenant B.
  - Because it runs in the caller's transaction, `enqueue()` still adds the job inside the same `withTenant()` transaction as the action and its audit event (the atomic approve-and-send in the architecture overview).
  - Its SQL is checked against the pinned pg-boss version, and a pg-boss upgrade must re-run its tests.
- Only the `jobs` role can read, update or delete jobs.
- Test: `leak: app role cannot select, update or delete pgboss jobs` and `enqueue commits atomically with the action`, `app_enqueue returns the existing job ID for a duplicate singleton key` (#44).

### 4. pgvector under RLS

- Every embedding table has `tenant_id` with RLS like any other table. Every vector query also filters on `tenant_id = $1` explicitly, so the intent is visible in code. HNSW still filters only after the index search, so this doesn't fix recall by itself.
- Vector queries run `SET LOCAL hnsw.iterative_scan = relaxed_order` inside `withTenant()` (pgvector ≥ 0.8; transaction-local because of pooling, per ADR 0003), so the index keeps scanning until it finds enough rows that pass the filter.
- If recall is still too low at scale, the fallback is a partial index per large tenant or per-tenant partitions. That needs a new ADR; we don't build it now.
- Test: `leak: vector search as A returns no B embeddings` (#8) and an eval case `vector recall for a small tenant among large ones` (#8, eval harness from #48).

### 5. LISTEN/NOTIFY

- A NOTIFY payload carries **only** `{tenantId, kind, id}`. No content, no names, no email addresses. Postgres has no per-channel permissions, so any role that can `LISTEN` sees every payload. Keeping payloads free of content makes that harmless.
- The `Broadcaster` forwards an event to a WebSocket only if the connection's tenant equals `tenantId`. The client then fetches the content through the normal API, which goes through `withTenant()`.
- Test: `broadcaster drops events for other tenants` and `notify payload schema has no content fields` (#8).

### 6. Views and functions

- Every view is created `WITH (security_invoker = true)`, so RLS applies as the caller, not as the view's owner.
- No `SECURITY DEFINER` function without an explicit review. Each one needs a comment explaining why, `SET search_path` pinned, and a leak-suite case. CI fails when a migration adds one that isn't listed in an allowlist file.
- Test: `migrations: every view is security_invoker` and `migrations: SECURITY DEFINER only in allowlist` (both are catalog checks against the migrated database, #44).

### 7. Unique constraints and existence side channels

- Uniqueness for tenant data is always **per tenant**: `UNIQUE (tenant_id, …)`, never a global unique on a value like a customer email. A global unique would let tenant A learn that a value exists in tenant B from the error.
- Values that really are global (mailbox addresses that route inbound mail, user emails in `auth`) are written only through narrow functions that return a generic "not available" result. That error never says which tenant owns the value.
- Any lookup by ID from another tenant returns `404`, the same as an ID that doesn't exist.
- Test: `leak: creating a customer with B's email succeeds in A` and `leak: fetching B's ticket ID as A returns 404` (#44).

## Rejected

- **RLS on Better Auth tables with a "current user" setting.** That's a second session variable that every auth query must set correctly. A separate role and schema is simpler, and a mistake makes a query fail instead of leak.
- **A database per tenant.** Strong isolation, but it breaks one-image self-hosting (ADR 0002) and multiplies migrations.
- **Tenant content in job payloads for speed.** It saves one read, but it copies tenant data into a table RLS doesn't cover.

## Consequences

- Workers can't forget `withTenant()`, because they never get a client without it.
- Three database roles beyond migrations: `app`, `auth` and `jobs`. Local dev and the Docker image must create all of them.
- Realtime events cost one extra API fetch per update. That's acceptable at MVP scale; ADR 0006 budgets still apply.
- Each test named above becomes a leak-suite case in #44 (MVP parts) or #8 (the rest).
