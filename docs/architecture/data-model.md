# Data model

What is in the database, who owns each row, and who may touch it. This page **summarises** [ADR 0003](../adr/0003-tenant-isolation.md) and [ADR 0009](../adr/0009-tenant-isolation-extended.md) and must never contradict them. The schema is [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts); the migrations are the source of truth for what Postgres enforces.

A leak test reads this page: every table in the `public` schema must appear below in backticks (see [Adding a table](#adding-a-table)).

## Tables

Every table is in the `public` schema, has row-level security (RLS) enabled **and forced**, and has a `tenant_isolation` policy that matches the owner column against `app.tenant_id`. The owner column is `tenant_id` everywhere except `tenants`, where it is `id`.

| Table                  | Owner column | What it holds                                                                                          |
| ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `tenants`              | `id`         | A workspace: name, shadow mode, AI budget. The root of tenancy.                                        |
| `memberships`          | `tenant_id`  | Which user belongs to which workspace, and as what (`owner` or `member`).                              |
| `mailboxes`            | `tenant_id`  | A support address. Inbound mail is routed to its workspace by address.                                 |
| `customers`            | `tenant_id`  | Someone who writes in, identified by email.                                                            |
| `tickets`              | `tenant_id`  | A conversation with one customer, in one mailbox.                                                      |
| `messages`             | `tenant_id`  | An email on a ticket, inbound or outbound.                                                             |
| `attachments`          | `tenant_id`  | Metadata of a message's attachment. The bytes live in the files adapter.                               |
| `drafts`               | `tenant_id`  | A reply (or a "fixed" notice) waiting for approval, then sent or discarded.                            |
| `draft_citations`      | `tenant_id`  | The knowledge passages a draft was written with, copied as the draft saw them.                         |
| `knowledge_sources`    | `tenant_id`  | A knowledge document: a web page or a markdown text.                                                   |
| `knowledge_chunks`     | `tenant_id`  | A passage of a source with its embedding, for vector search.                                           |
| `integrations`         | `tenant_id`  | A workspace's link to an outside service (GitHub: repo, plus the token and webhook secret, encrypted). |
| `ticket_github_issues` | `tenant_id`  | The GitHub issue made from a ticket.                                                                   |
| `api_tokens`           | `tenant_id`  | An agent's token, stored as a hash, with its scopes. Revoked, never deleted.                           |
| `audit_events`         | `tenant_id`  | Append-only log of every human, agent and system action.                                               |
| `ai_usage`             | `tenant_id`  | AI tokens a workspace used (and has reserved) per UTC day, for the daily budget.                       |

## Relationships

- A `ticket` belongs to a `customer` and a `mailbox`. It has many `messages`, and a message has many `attachments`.
- A `draft` answers one inbound `message` on a `ticket`. It has many `draft_citations`, which point at a `knowledge_source` until that source is deleted (then the pointer becomes null and the copied passage stays).
- A `knowledge_source` has many `knowledge_chunks`. Deleting the source deletes its chunks.
- A `ticket` has at most one `ticket_github_issues` row. A workspace has at most one `integrations` row per provider.
- Relations between tenant tables use composite keys on `(tenant_id, id)`, so a row can't point at another tenant's row even if RLS were off.

## Other schemas

- **`auth`** holds `users`, `sessions`, `accounts` and `verifications` for sign-in. Users span workspaces, so these tables have no `tenant_id` and no RLS. Only the `auth` role can use the schema; the app role can't read or write it.
- **`pgboss`** holds the job queue. The `jobs` role owns it, and the app and `auth` roles have no privileges on it. The app enqueues only through `jobs_api.app_enqueue()`, the one `SECURITY DEFINER` function, which is on the reviewed allowlist.

## Roles

| Role  | Used by                | Can                                                                       |
| ----- | ---------------------- | ------------------------------------------------------------------------- |
| owner | migrations             | Create and change tables. No `BYPASSRLS`: RLS binds it too.               |
| app   | the API and the worker | Read and write tenant tables, inside `withTenant()` only. No `BYPASSRLS`. |
| auth  | the sign-in module     | Use the `auth` schema. Nothing in `public`.                               |
| jobs  | pg-boss                | Own the `pgboss` schema.                                                  |

## Special grants

- `audit_events`: the app role can insert and read, never update, delete or truncate.
- `api_tokens`: the app role can create a token and revoke it (set `revoked_at`). It can't rewrite a hash, widen scopes, move a token to another workspace or delete one.
- `mailboxes`, `api_tokens` and `memberships` have a second, read-only policy each (by address, by token hash, by your own user), so a request can find its workspace before it knows it. Each shows exactly the one row, or the caller's own rows, that the caller already named.

## Uniqueness

Uniqueness of tenant data is per tenant (`UNIQUE (tenant_id, ...)`): customer email, Message-ID, knowledge slug and URL, GitHub repo and issue. A clash never tells a workspace that another one has the value. Two values are global on purpose: a mailbox address (one address routes to one workspace) and an API token hash (a hash of 32 random bytes). Both are written through code that reports a clash as a generic "not available".

## Adding a table

1. **Migration.** Give the table a `tenant_id` and `ENABLE` and `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy (see `packages/db/migrations/0001_tenants-rls.sql`). A table with no `tenant_id` needs a reason in `schema.test.ts` and a change to `tenantSnapshot()`.
2. **A row in `seedLeakTenant`** (`packages/db/src/testing.ts`), so the leak tests have something to look for. Put the workspace's `tag` in every text value.
3. **A line on this page**, with its name in backticks, its owner column and what it holds.

Until all three exist, the leak tests fail: `packages/db/src/leak.test.ts` (read, update and delete as another workspace, over every table) and `apps/server/src/leak.int.test.ts` (every API operation as another workspace).
