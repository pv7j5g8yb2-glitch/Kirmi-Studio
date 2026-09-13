# Production readiness

Status: **the system runs and is tested end to end against a real database and signed
webhooks. No external provider is connected.**

## Ready

| Area | State |
|---|---|
| Tenant isolation | Postgres RLS, non-superuser app role, proven by tests |
| Authentication | scrypt password hashing, hashed session tokens, 12h expiry, uniform login failure |
| Authorization | role + membership checks on every tenant route |
| Secrets | env-only via zod; nothing in `src/web` imports config |
| Webhook security | HMAC-SHA256 over raw bytes; unsigned traffic refused; unconfigured channels return 503 rather than accept |
| Idempotency | three layers (event ledger, message id, outbox key) |
| Delivery | retry with backoff, dead-lettering, parking when NOT_CONNECTED |
| Money | integer fils end to end |
| Booking integrity | state machine + authoritative confirmation only |
| Audit | every significant action recorded |
| Health | `/healthz`, `/readyz`, Docker healthcheck |
| Build | typecheck, lint and 73 tests all green |

## Before real customer traffic

1. **Set `SESSION_SECRET`** to 64 random hex characters. Startup refuses the dev default in production.
2. **Terminate TLS** in front of the app. Session cookies set `secure` when `NODE_ENV=production`.
3. **Create `kirmi_app` with a password** and grant it as in `schema.sql`. Never point the app at the owner role — that silently disables RLS.
4. **Rotate the seeded operator passwords.** `seed-deiz.ts` uses `change-me-now` unless `SEED_ADMIN_PASSWORD` is set.
5. **Back the database up** and test a restore.
6. **Sign the agreement and settle the data-processing basis** before real customer conversations flow through Kirmi.

## Known limits

- **Scheduler is in-process.** Fine for one node. The outbox uses `SKIP LOCKED` so moving
  to a separate worker is a deployment change, not a code change.
- **No rate limiting per tenant** on outbound. Meta enforces its own; we do not pre-throttle.
- **Document media is referenced, not stored.** No object storage is wired up; `media_ref`
  holds the provider's id. Fine for WhatsApp-hosted media, insufficient if DEIZ needs retention.
- **No LLM fallback in production use.** The deterministic engine handles the rental domain;
  anything it cannot parse escalates to a person. That is a deliberate trade, not a gap.
- **Single region, single database.** No read replicas or failover.
- **Reactivation sweep runs every 6 hours** in-process; a real cron is preferable.

## Scaling notes

The first constraints will be, in order: outbound message rate limits imposed by Meta;
the scheduler running on one node; and Postgres connection count (pool max 10 per
instance). None bite below a few thousand conversations a month.
