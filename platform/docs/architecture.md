# Architecture

## What this is

The inbound sales and booking department for a vehicle-rental company, operating over
the channels its customers already use. The web console is an operations tool for staff;
the product is the message loop.

## Shape

```
customer → WhatsApp / Instagram / missed call
              ↓ provider webhook (signature-verified, idempotent)
         ingest → identify customer → open/route conversation
              ↓
         conversation engine  ── tools ──→ fleet · availability · pricing · rules
              ↓                              (no fact is stated that a tool did not return)
         outbox (retry + backoff) → provider → customer
              ↓
         operator console: monitor · take over · confirm · report
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22, TypeScript, ESM | one language across webhook, engine and console |
| HTTP | Fastify 5 | raw-body access for webhook signatures, low overhead |
| Database | PostgreSQL 16 | row-level security gives real tenant isolation |
| Access | `pg` + hand-written SQL | RLS session variables and `FOR UPDATE SKIP LOCKED` need direct control |
| Validation | zod | one schema for env and request bodies |
| Tests | vitest against a real Postgres | isolation and locking cannot be tested against a mock |

No ORM: the security model depends on session-scoped connections and specific locking
clauses, both of which an ORM abstracts away at exactly the wrong moment.

## Tenant isolation

Every tenant-scoped table carries `tenant_id` and a policy comparing it to
`app.tenant_id`, set per transaction by `withTenant()`. `FORCE ROW LEVEL SECURITY` makes
it apply to the table owner too.

The application connects as `kirmi_app`, which is `NOSUPERUSER NOBYPASSRLS` — **this is
load-bearing.** Postgres exempts superusers from RLS entirely, so connecting as the owner
silently disables every policy. Migrations run as the owner; the app never does.

`withAdmin()` sets `app.bypass_rls` for migrations and the Kirmi cross-tenant views. It is
the only escape hatch and is used in two places.

## Truthfulness rules

These are enforced in code, not convention:

1. **Availability** is only asserted when `rules.inventoryAuthoritative` is true. Otherwise
   every quote carries "subject to confirmation".
2. **Bookings** reach `confirmed` only via `confirmReservation()` with an explicit source:
   `payment_provider`, `staff` (which must name the operator), or `external_system`.
3. **Cash and crypto** can never reach `paid` — only `confirmed_by_staff`, against a named user.
4. **Prices** come from the tenant's rate table through the pricing engine. Money is integer
   fils throughout; floats never touch a quote.
5. **Unknowns escalate.** A message the engine cannot answer truthfully sets the conversation
   to `human_active` rather than guessing.

## Human takeover

`conversations.state` is `ai_active | human_active | closed`. The orchestrator re-reads
state immediately before replying and returns silence when a person holds the thread.
Follow-ups skip those conversations entirely.

## Delivery

Replies are persisted then queued in `outbox`, drained by the scheduler with exponential
backoff (30s → 15m, 6 attempts). Two behaviours matter:

- a **permanent** failure is marked `dead` at once rather than retried six times;
- an **unconfigured** channel parks the message as `pending` with zero attempts, so
  everything queued while NOT_CONNECTED goes out the moment credentials land.

`FOR UPDATE SKIP LOCKED` makes the drain safe to run on several instances.

## Demo vs production

Separate tenants with a `mode` column. `providerFor()` hands demo tenants a mock provider
regardless of environment, so a demo cannot send a real message or take a real payment
even when live credentials are present.
