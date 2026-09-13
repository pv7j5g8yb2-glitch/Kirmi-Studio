# Testing

```bash
# once, as the database owner
DATABASE_URL='postgresql://kirmi@/kirmi_test?host=/tmp&port=5433' npm run migrate
npm test
```

Tests run against a **real PostgreSQL**, not a mock. Row-level security, `FOR UPDATE SKIP
LOCKED` and partial unique indexes are the things most likely to be wrong, and none of
them exist in a fake. Tests connect as `kirmi_app` so every query is subject to the same
policies as production.

## Coverage — 73 tests

| Suite | What it proves |
|---|---|
| `tenancy` (6) | RLS blocks cross-tenant reads **and** writes, the session var does not leak across pooled connections, audit rows are per tenant |
| `engine` (23) | Arabic-Indic digits, locale detection, relative/weekday/day-first dates, week and month durations, intent classification, tiered pricing, integer money, delivery waiver, slot carry-over across turns, Arabic quoting, replay safety, escalation, AI silence under human takeover, alternative offers |
| `booking` (16) | transition legality, hold conflicts, adjacent rentals not colliding, no shortcut to confirmed, staff confirmation naming an operator, hold expiry releasing inventory, document workflow, cash vs card asymmetry, outbox backoff/idempotency/parking |
| `webhook` (17) | signature accept/reject/tamper/wrong-secret, Meta challenge, IG echo suppression, health, full signed loop to a queued reply, retry idempotency, auth required, cross-tenant 403, uniform login failure |
| `followups` (11) | ladder scheduling, 24h window enforcement, template requirement, skipping human-held threads, cancellation, reactivation exactly-once, no reactivation after booking, revenue counted only when confirmed, demo/production provider isolation |

## What is not covered

- **No live provider call is tested**, because no credentials exist. Provider adapters are
  exercised through `MockMessagingProvider` / `MockPaymentProvider` and signed fixtures.
  Real delivery is unproven until a token exists — that is what NOT_CONNECTED means.
- No browser tests for the console. It is a thin client over a tested API.
- No load testing.
