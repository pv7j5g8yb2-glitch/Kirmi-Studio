# Kirmi Core Engine

A multi-tenant revenue conversion backend. One codebase serves every B2B client,
and onboarding the next one is two database rows, not a deploy.

Built first for luxury car rental in the UAE, where the shape of the problem is
sharp: enquiries arrive on WhatsApp at 2am, the customer is messaging four
companies at once, and whoever answers first with a real price usually wins. The
engine answers in seconds, prices from the client's own rate card, holds the
actual car, and hands anything unusual to a person.

## What it guarantees

Four things, each enforced by something stronger than a code review.

**A client cannot see another client's data.** Every tenant table runs under
PostgreSQL row level security, forced, keyed on a transaction local setting.
Isolation is not applied by the application, it is applied underneath it, so a
forgotten `WHERE` clause returns nothing rather than returning everything.

**Two customers cannot book the same car.** The reservation path takes
`SELECT ... FOR UPDATE NOWAIT` on the vehicle row before it checks anything,
which makes concurrent attempts sequential and gives the loser a fast, clean
rejection. A GiST exclusion constraint sits behind that as a second line.

**A duplicate webhook cannot produce a duplicate quote.** An atomic Redis claim
on the carrier's own message id drops replays in under a millisecond, with a
unique index in Postgres as the durable backstop.

**The model never invents a number.** The LLM parses text into structured
arguments. Every figure a customer sees comes out of a pure pricing function,
and the tool schemas give the model no field through which to supply a price of
its own.

Each of those has tests that prove it against a real PostgreSQL and a real
Redis, because a mock of a row lock proves only that the mock agrees with
itself. See [docs/testing.md](docs/testing.md).

## Layout

```
kirmi-core-engine/
├── prisma/
│   ├── schema.prisma          the data model, every tenant row keyed on client_id
│   ├── migrations/            SQL, including the RLS policies and lock constraints
│   └── seed.ts                onboarding one client, start to finish
│
├── src/
│   ├── config/                platform settings and the per client config contract
│   ├── core/                  STATELESS. pricing, availability, qualification, money
│   │   ├── pricing/           the only code allowed to decide what a customer owes
│   │   └── availability/      the pure half of "can this car be sold"
│   ├── db/                    Prisma client and the tenant isolation layer
│   ├── cache/                 hot context cache and the idempotency store
│   ├── queue/                 BullMQ queues and the worker processes
│   ├── channels/              outbound delivery to WhatsApp and Instagram
│   ├── middleware/            signature verification, isolation, idempotency
│   ├── routes/                Meta and Twilio inbound, metrics API, human inbox
│   ├── services/              the tenant aware domain layer
│   ├── orchestrator/          LLM boundary, tool schemas, the reply pipeline
│   ├── realtime/              the human inbox WebSocket
│   └── server.ts              the API gateway
│
├── scripts/                   role provisioning and an isolation audit
├── tests/
│   ├── unit/                  pure logic, no infrastructure, milliseconds
│   └── integration/           real Postgres and Redis, real locks, real policies
└── docs/
```

The split that matters is `src/core/` against everything else. Core is pure:
no database handle, no clock of its own, no network. That is what lets the
pricing rules be tested exhaustively in milliseconds and what stops a schema
change quietly altering a price.

## Getting started

```bash
cp .env.example .env          # then fill it in
npm install

docker compose up -d postgres redis

# Three roles, and the separation is a security boundary. The app role must
# never carry BYPASSRLS, which switches tenant isolation off silently.
SUPERUSER_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
  psql "$SUPERUSER_DATABASE_URL" -v app_password=... -v migrate_password=... \
       -v admin_password=... -f scripts/provision-roles.sql

npm run prisma:migrate        # runs as MIGRATION_DATABASE_URL
npm run db:seed               # creates a first tenant, prints its API key once
npm run db:verify-isolation   # confirms RLS is on, forced, and policied everywhere

npm run dev                   # API gateway on :3000
npm run worker                # queue workers, separate process
```

Two processes, same image. The API acknowledges webhooks in milliseconds; the
workers do the slow work. Sharing one process means a slow model call eventually
competes with a webhook acknowledgement, and Meta responds to a slow
acknowledgement by redelivering.

## Onboarding a client

Read `prisma/seed.ts`. Notice what it does not do: it touches no file in `src/`,
adds no branch, registers no route. It writes a `clients` row and a
`client_configurations` row.

Everything that varies between clients lives in that configuration row. Opening
hours, supported languages, minimum driver age and per category overrides, VAT
rate, weekly and monthly bracket thresholds, delivery fees and waivers, seasonal
modifiers, the add-on catalogue, hold and quote lifetimes, channel credentials,
escalation targets, and Kirmi's own commercial terms with that client.

Copy the file, change the values, run it. Nothing is deployed.

## How a message becomes a reply

```
WhatsApp/Instagram/missed call
  ↓
resolve tenant          from the payload's phone_number_id or page id
  ↓
verify signature        HMAC, against THAT tenant's secret, over the raw bytes
  ↓
idempotency claim       atomic SET NX on the carrier's message id
  ↓
persist + enqueue + 200 everything after this point is asynchronous
  ↓
[worker] load context   Redis first, Postgres on a miss
  ↓
[worker] ask the model  it may call SEARCH_VEHICLES, CHECK_AVAILABILITY, CREATE_HOLD
  ↓
[worker] execute tools  real fleet, real pricing engine, real row locks
  ↓
[worker] compose reply  the model phrases what the tools returned, verbatim
  ↓
[worker] check aiEnabled again, inside the writing transaction
  ↓
record, then dispatch
```

The `aiEnabled` check appears twice on purpose. Seconds pass between asking the
model and writing its answer, which is ample time for a human to hit take over,
and the agent must not get one last word in after that.

## The metrics API

Four channels, shaped for a React or Next.js dashboard:

```
GET /api/metrics/summary?days=30     enquiries, bookings, revenue, Kirmi fee
GET /api/metrics/daily?days=30       daily buckets, in the client's own timezone
GET /api/inbox/escalations           the human handover queue
POST /api/inbox/conversations/:id/ai the kill switch
WS  /realtime/inbox?key=...          live escalations
```

Every figure is replayed from the append only ledger rather than kept as a
running total, so the dashboard and the invoice cannot drift apart. Revenue is
reported gross, cancelled and net separately, because one number cannot honestly
say all three.

## Documentation

- [docs/architecture.md](docs/architecture.md) the layering, and why each boundary is where it is
- [docs/tenancy.md](docs/tenancy.md) how isolation actually works, and how to audit it
- [docs/testing.md](docs/testing.md) what is proved, and how to run it
- [docs/operations.md](docs/operations.md) deployment, roles, failure modes

## Known limits

Stated plainly, because a README that only lists strengths is not useful.

- Payments are closed end to end. `src/payments` issues the link, and
  `POST /webhooks/stripe/:clientSlug` confirms the reservation when Stripe says
  the money arrived, per tenant and signature verified. A `manual` provider
  remains for clients with no gateway, where settlement is confirmed at the
  desk. Refunds and disputes are not handled; those are still a person's job.
- Document verification is a flag on `Customer`, set by whatever process does
  the checking. There is no OCR or identity provider integration.
- The LLM client speaks to the Anthropic Messages API over `fetch`. It has not
  been exercised against the live API in this repository's test suite; the
  pipeline tests use a scripted model so they measure this engine's own latency
  rather than a provider's.
- Telephony is inbound only. A missed call becomes a WhatsApp message, because
  nobody wants a robot ringing them back, and an SMS if that number turns out
  not to be on WhatsApp.
- WhatsApp templates are configured per client and must match what Meta
  approved, name and language exactly. Nothing here can verify that: a mismatch
  surfaces as a refused send, logged with both values.
- The follow up sweeper is a worker on a queue, so something has to enqueue it
  on a schedule. There is no cron in this repository; `operations.md` gives the
  interval.
- One advisory in `npm audit` is accepted: `deepmerge-ts`, reached only through
  the `prisma` CLI, which is a devDependency and is not installed in the runtime
  image (`npm ci --omit=dev`). The runtime `@prisma/client` has no dependencies
  at all.
