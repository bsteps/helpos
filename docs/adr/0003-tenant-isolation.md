# 0003. Tenant isolation with Postgres RLS and `withTenant()`

- Status: Accepted
- Date: 2026-11-06

## Context

The hosted version serves many companies from one database. One company seeing another's conversations would end the product. An application-level `WHERE tenant_id = …` alone fails the first time someone forgets it. Connection pooling adds a second trap: a session-level setting can leak to the next request that reuses the connection.

## Decision

1. Every tenant-owned table has a `tenant_id` column with **`ENABLE` and `FORCE ROW LEVEL SECURITY`**. The policy is `tenant_id = current_setting('app.tenant_id')::uuid`.
2. The app connects as a role **without `BYPASSRLS`**. Migrations and pg-boss maintenance use separate, explicitly named roles.
3. Code reaches tenant data **only** through `withTenant(tenantId, async (tx) => …)`. It opens a transaction and runs `set_config('app.tenant_id', $1, true)`; the `true` makes the setting transaction-local, so it's safe with PgBouncer in transaction mode.
4. A lint rule bans importing the raw database client outside the `db` package.
5. CI runs a **cross-tenant leak suite**: it creates tenants A and B and asserts that every repository and API endpoint returns nothing of B's data when acting as A. This covers embeddings and search too.

## Consequences

- A bug in a query can't leak data across tenants, because the database itself refuses.
- Every request that touches data runs in a transaction. That's slightly more overhead, and an acceptable cost.
