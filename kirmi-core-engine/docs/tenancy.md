# Tenant isolation

The guarantee: a client cannot read, write, count, aggregate or otherwise
observe another client's data, and this holds even when the application code is
wrong.

That last clause is the whole point. Every multi-tenant system claims isolation;
most of them mean "every query has a `WHERE client_id = ?` and we are careful".
Careful is a property of a team on a good day. This system puts the boundary
somewhere that does not depend on anybody's attention.

## How it works

Four layers, in the order a request meets them.

### 1. Every tenant row carries `client_id`

Not most rows. Every row. A table without it is a table outside the guarantee,
which is why the one table that genuinely has to be readable before a tenant is
known, `tenant_directory`, holds nothing but routing identifiers.

### 2. Row level security, enabled and FORCED

```sql
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vehicles
  USING      (client_id = kirmi_current_client_id())
  WITH CHECK (client_id = kirmi_current_client_id());
```

`ENABLE` applies policies to everyone except the table owner. `FORCE` removes
that exemption, so the role that owns the schema is confined too. That matters
because pointing an application at the owner's connection string is a
depressingly easy mistake, and without `FORCE` it silently switches isolation
off with nothing logged.

`USING` filters reads, updates and deletes. `WITH CHECK` filters writes, which
is what stops a tenant inserting a row stamped with someone else's id.

### 3. A transaction local setting

```ts
await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${clientId}, true)`;
```

The `true` is the most important character in the codebase. It makes the setting
transaction local, so it is discarded at `COMMIT` or `ROLLBACK` and cannot
survive on a pooled connection to contaminate whoever borrows it next. There is
a test that asserts exactly this, because the failure it prevents is invisible
until it is catastrophic.

When nothing has been set, `kirmi_current_client_id()` returns `NULL`, and
`client_id = NULL` is `NULL`, which is not `TRUE`. An unscoped connection
therefore sees an empty database rather than everybody's. The failure mode is an
empty result, never a leak.

`kirmi_current_client_id()` is marked `STABLE`, not `IMMUTABLE`. Marking it
`IMMUTABLE` would let the planner fold one tenant's id into a cached plan reused
by another tenant. One word, load bearing.

### 4. Ambient scope in the application

`AsyncLocalStorage` carries the resolved `clientId` for the life of a request,
so a handler does not pass it down through four layers and hope nobody drops it.
Reaching the database without a scope throws rather than returning nothing,
because code that gets there has a bug and should produce a stack trace, not a
quietly empty result.

## There is deliberately no bypass switch

No `app.bypass_rls` setting, no "admin mode" flag. A GUC that switches isolation
off is precisely the switch an injected statement would reach for.

Break glass access is a separate role, `kirmi_admin`, carrying the `BYPASSRLS`
attribute, provisioned outside the request path and never configured into a
running service. Using it is a deliberate act by a person.

## The three roles

| Role | Owns schema | BYPASSRLS | Used by |
|---|---|---|---|
| `kirmi_migrate` | yes | no | migrations only |
| `kirmi_app` | no | **no** | every request |
| `kirmi_admin` | no | yes | incident response, lawful erasure |

`NOBYPASSRLS` on `kirmi_app` is the single most important line in
`scripts/provision-roles.sql`. A superuser or a `BYPASSRLS` role ignores every
policy in the schema without raising anything.

## The one table outside the model

`tenant_directory` has no RLS, and the reason is ordering. A webhook from Meta
identifies its destination by `phone_number_id`. Nothing can be scoped to a
tenant before we know which tenant it is, so something has to be readable first.

That table holds routing keys, a trading name and a timezone. No customers, no
prices, no conversations, no credentials. Reading all of it tells an attacker
which businesses use Kirmi and nothing else. It is maintained by database
triggers rather than application code, so it cannot drift, and the app role is
explicitly granted `SELECT` and revoked everything else: an application that can
rewrite its own routing table can point another tenant's WhatsApp number at
itself.

## Auditing it

```bash
npm run db:verify-isolation
```

Answers three questions: is RLS enabled and forced on every tenant table, does
every such table carry a policy, and is the app role free of `BYPASSRLS`. Any
row in the first two outputs is a hole. Safe to run against production.

## What is tested

`tests/integration/tenant-isolation.test.ts`, against a real PostgreSQL:

- an unfiltered `findMany` returns only the caller's rows
- a `findUnique` with another tenant's exact primary key returns null
- a write stamped with another tenant's id is rejected
- `updateMany` and `deleteMany` across the boundary affect zero rows
- counts and aggregates cannot leak another tenant's totals
- raw SQL is confined identically to the ORM
- an unscoped connection sees nothing at all
- the tenant setting does not survive onto the next user of a pooled connection
- a suspended tenant cannot be routed to
- the routing projection follows the tenant automatically

Several of those tests deliberately write the careless query on purpose. They
are supposed to return nothing, and the reason they return nothing is Postgres.
