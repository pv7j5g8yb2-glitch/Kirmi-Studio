# Database

PostgreSQL 16. One schema, applied idempotently by `npm run migrate` (as the owner).

## Conventions

- **Money** is `bigint` minor units (fils). 1 AED = 100. Never `numeric`, never float.
- **Times** are `timestamptz`. Tenant-local display uses `tenants.timezone` (Asia/Dubai).
- **Ranges** are half-open: a rental ending at T does not collide with one starting at T.
- Every tenant-scoped table has `tenant_id uuid NOT NULL` and an RLS policy.

## Tables

| Table | Purpose | Notable constraints |
|---|---|---|
| `tenants` | client accounts | `mode` demo/production |
| `tenant_settings` | business rules as data | `provenance`: verified_public / client_provided / assumed |
| `users`, `memberships`, `sessions` | operators | sessions store a SHA-256 of the token |
| `integrations` | per-channel state | the five mandated states |
| `vehicles` | fleet + rate card | rates in fils; `min_days` |
| `vehicle_blocks` | holds, bookings, maintenance | `source` distinguishes authoritative rows |
| `customers` | identified by phone or IGSID | unique per tenant |
| `conversations` | one thread per customer/channel | `last_inbound_at` drives the 24h window |
| `messages` | full history | partial unique index on `provider_message_id` = idempotency |
| `webhook_events` | raw delivery ledger | unique `(channel, provider_event_id)` |
| `enquiries`, `quotes` | pipeline | `quotes.availability_confirmed` gates wording |
| `reservations` | booking state machine | `confirmation_source` required to confirm |
| `reservation_events` | transition history | append-only |
| `documents` | passport/licence workflow | holds a reference, never the bytes |
| `payments` | intents and outcomes | cash/crypto stop at `confirmed_by_staff` |
| `followups` | scheduled outreach | `requires_template` for outside-window sends |
| `outbox` | send queue | unique `(tenant_id, idempotency_key)` |
| `audit_log` | every significant action | intentionally outside RLS |

## Idempotency

Three independent layers, because Meta retries until it gets a 200:

1. `webhook_events` — the raw delivery is recorded before parsing.
2. `messages.provider_message_id` — a replayed message cannot be stored twice.
3. `outbox.idempotency_key` — keyed `reply:<inbound message id>`, so a replay cannot
   produce a second answer even if it got past the first two.

## Migrations

`src/db/schema.sql` is idempotent (`IF NOT EXISTS`, policies dropped and recreated). Run
it as the **owner**; the app role cannot create objects by design.

```bash
DATABASE_URL='postgresql://kirmi@host/kirmi' npm run migrate
```
