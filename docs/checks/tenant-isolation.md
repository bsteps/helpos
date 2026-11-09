# Check: tenant isolation

What the tenant-isolation check looks for in a diff. Follow it when you write code too. The reasons are in [ADR 0003](../adr/0003-tenant-isolation.md) and [ADR 0009](../adr/0009-tenant-isolation-extended.md); section numbers below point into ADR 0009.

## Flag

1. **Raw database access outside `packages/db`.** A database client, `postgres`, `drizzle-orm/postgres-js` or `pg-boss` used anywhere else. Biome blocks the plain imports, so look for ways around it: a dynamic `import()`, a re-export, a suppression comment.
2. **Tenant data outside `withTenant()`.** Every query on a tenant table runs on the `tx` that `withTenant(tenantId, …)` passes in. Flag a `tx` that is stored, returned, or used after its callback ends.
3. **Tenant from the wrong place.** The `tenantId` comes from the authenticated principal (session or token) or a validated job payload. Never from a request body, query string or header the caller controls.
4. **A new tenant table without RLS.** The migration adds `tenant_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and the tenant policy. A table without `tenant_id` needs a stated reason.
5. **Global uniqueness on tenant data.** A `UNIQUE` on a value such as an email without `tenant_id` in it (§7).
6. **Views and functions.** A view without `security_invoker = true`, or a new `SECURITY DEFINER` function (§6).
7. **Jobs.** A tenant job without `tenantId`, a payload that carries content instead of IDs, or a handler that gets a database client some way other than the job runner (§2, §3).
8. **Realtime payloads with content.** A NOTIFY or broadcast payload with more than tenant, kind and ID (§5).
9. **Vector queries without an explicit `tenant_id` filter** (§4).
10. **Answers that reveal another tenant.** Another tenant's ID must get the same `404` as an ID that doesn't exist, not a `403` or a different error (§7).
11. **New tenant data access without a cross-tenant test.** A new table, query function or endpoint over tenant data needs a leak test: acting as tenant A returns nothing of tenant B's. This is the only test this check asks for.

## Don't flag

- The implementation of `withTenant()`, the migration runner and the database roles inside `packages/db`.
- Style, naming, performance, or anything not about tenant isolation. Other checks cover those.
