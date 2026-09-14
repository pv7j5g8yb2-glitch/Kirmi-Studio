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

## Proactive messaging

Two things run on a timer rather than in response to a customer, and both need
something outside this repository to enqueue them.

| Queue | Interval | What happens if it stops |
|---|---|---|
| `hold-sweeper` | every 5 minutes | Expired holds are never released, and cars stay off the market |
| `follow-up-sweeper` | every 5 minutes | Quiet customers are never chased, and conversion quietly reverts to what it was before |

Both are idempotent and platform wide, so running them more often is harmless
and running two copies is safe. Enqueue with BullMQ's repeatable jobs, a
Kubernetes CronJob, or the scheduler your platform already has.

### The 24 hour window

Meta allows a free form message only within 24 hours of the customer's last
one. Outside it the only permitted form is a template the business registered
in advance, and this is the single most common reason a follow up appears to do
nothing: the send is refused by the carrier, not by this engine.

`client_configurations.message_templates` holds the approved set. Name and
language must match Meta exactly. `src/channels/messaging-window.ts` treats the
last ten minutes of the window as already closed, because the window shuts on
Meta's clock rather than ours and a send that leaves at 23h59m can arrive after
it has shut.

### Quiet hours

`follow_up_policy.quietHours` applies only to messages the engine starts, never
to replies. Answering a customer at 03:18 is the product; ringing their phone
at 03:18 to say a quote is still available is a complaint and, eventually, a
block. A due follow up inside quiet hours is deferred to the end of the window,
not dropped.

## The human inbox

Served by the API process itself at `/inbox`, as a static page with no build
step and no second deployment. It calls `/api/inbox` on the same origin, so
there is no CORS to configure.

Sign in with a client API key carrying the `inbox:read` scope
(`npm run db:issue-key`). The key is typed by the person using it and kept in
their browser; the page holds no secret of its own.

Typing a reply takes the conversation over implicitly. Requiring a switch to be
flipped first is a step that gets skipped under pressure, and the failure mode
is a customer being answered twice, once by a person and once by the agent.

## Break glass

`kirmi_admin` holds BYPASSRLS for incident response and lawful erasure. Note
that BYPASSRLS alone is not enough: the role also needs table privileges, which
are granted in migration `20260914181718` rather than in `provision-roles.sql`,
because that script runs before any table exists.

Never configure a running service with this role.

## CI

`.github/workflows/ci.yml` runs on every push and pull request, against a real
PostgreSQL 16 and Redis 7 rather than mocks.

It exists because the three guarantees this engine sells cannot be checked by
reading a diff, and two of them fail *silently* when broken:

| Step | What it catches |
|---|---|
| `provision-roles.sql` then migrate | The app role connecting with BYPASSRLS, which turns isolation off with no error |
| `verify-isolation.sql` | A new tenant scoped table nobody enrolled in a policy |
| `npm test` | Double bookings, SLA regressions, window and attribution logic |
| `prisma migrate diff` | A schema edit that never made it into a migration |

The drift check runs against a database built **only** from the migration
files. Running it against a developer's existing database is the check passing
for the wrong reason, which has already happened once here.

If you hand this repository to a contractor, this workflow is the contract. A
green tick means they have not broken anything a client is paying for.
