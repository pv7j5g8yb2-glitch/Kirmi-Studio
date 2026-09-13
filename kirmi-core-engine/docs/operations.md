# Operations

## Processes

Two, from one image.

**API gateway** (`npm start`) serves HTTP and the inbox WebSocket. It must stay
fast: Meta redelivers anything it does not get a 200 for within a couple of
seconds.

**Workers** (`npm run worker:prod`) drain the queues: webhook ingest, outbound
delivery, hold sweeping.

Separating them is not ceremony. Background work sharing a process with the
webhook endpoint eventually competes with it for the event loop, and the
symptom is duplicate deliveries rather than slow ones.

Only the API process registers the recurring schedule. Registering it from every
worker creates one duplicate hold sweeper per pod.

## Database roles

| Role | Purpose | Notes |
|---|---|---|
| `kirmi_migrate` | owns the schema, runs migrations | no application traffic |
| `kirmi_app` | serves every request | **NOBYPASSRLS**, no DDL |
| `kirmi_admin` | break glass | `BYPASSRLS`, never in a running service |

`NOBYPASSRLS` on the app role is the line that matters. A superuser or a
`BYPASSRLS` role silently ignores every row level security policy in the schema,
so pointing the application at the wrong connection string turns isolation off
with nothing logged. `npm run db:verify-isolation` checks for exactly this.

## Deploy sequence

```bash
npm run prisma:migrate        # as MIGRATION_DATABASE_URL, before the new image
# roll the API and workers
npm run db:verify-isolation   # after any migration touching a table
```

Migrations are forward only and additive. The schema and the migration set are
kept in step by `prisma migrate diff --exit-code`, which should report no
difference; run it against a **clean** shadow database, since a dirty one
produces a false pass.

## Failure modes, and what happens

| What fails | What happens | What to do |
|---|---|---|
| Redis | Context cache misses fall through to Postgres. Replies get slower, not wrong. Idempotency falls back to the unique index on `webhook_events`. | Restore Redis. No data loss. |
| Redis, for the queue | Webhooks cannot be enqueued and the route errors. Meta retries. | Restore Redis; the retries drain. |
| Postgres | Readiness goes 503 and the balancer stops routing. | The engine is down. It does not degrade into guessing. |
| The LLM provider | The pipeline escalates rather than sending nothing. A person sees it. | Nothing automatic. Escalations queue up in the inbox. |
| Meta refuses a send | A `LOW_CONFIDENCE` escalation is raised naming the rejection. | A human picks up the thread. |
| Meta rate limits a send | Transient, retried with backoff by the queue. | Nothing. |
| A hold sweeper stops | Expired holds are never released. Cars silently become unsellable. | This is the quiet one. Alert on it. |

That last row deserves emphasis. Nothing in this system is more directly revenue
destroying than a sweeper that is not running, and nothing about it is visible
from the outside: bookings simply stop, one car at a time. Alert on
`HOLD_EXPIRED` events falling to zero while `HOLD_CREATED` continues.

## What to monitor

- **SLA breaches.** `SLA_BREACH` events in the ledger, and `slaBreached` on
  outbound messages. The client was promised something specific; this is whether
  it is being delivered.
- **Median reply latency**, not mean. One 40 second outlier drags a mean enough
  to hide a fleet otherwise answering in two seconds.
- **Escalation rate by reason.** A rising `LOW_CONFIDENCE` rate means the agent
  is struggling. A rising `AGE_BELOW_MINIMUM` rate is a marketing targeting
  problem, not an engineering one.
- **Open escalations older than an hour.** A customer is sitting there having
  been told a colleague would pick it up.
- **`WEBHOOK_REJECTED` events.** A sudden spike is either a rotated secret that
  was not updated, or somebody probing the endpoint.
- **Hold sweeper liveness**, as above.

## Secrets

Per tenant credentials are encrypted at rest with `SECRETS_ENCRYPTION_KEY`
(AES-256-GCM). The key itself belongs in a secrets manager, not in `.env` in
production.

Rotating it means decrypting with the old key and re-encrypting with the new,
per client configuration row. There is no automated rotation path yet; doing it
by hand for a handful of clients is honest work, and building a rotation
pipeline for three tenants would be premature.

Logs redact anything credential shaped at the serialiser (`src/core/logger.ts`),
so a careless `log.info({ config })` cannot spill a client's Meta secret into an
aggregator.

## Lawful erasure

The ledger is append only, enforced by a database trigger, because an invoice
replayed from editable rows is an assertion rather than evidence.

Erasing a customer therefore means disabling that trigger deliberately, as the
owner role, doing the deletion, and re-enabling it. That is inconvenient on
purpose: it is a visible act rather than a stray `UPDATE`, and it leaves a trace
in the audit trail of whoever has database access.
