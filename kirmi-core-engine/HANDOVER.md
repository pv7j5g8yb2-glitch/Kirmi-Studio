# Handover: what is built, what is left, and who does it

Read this before quoting. It is the whole job in one file.

This is not a fleet management CRM and it is not a dashboard product. It is a
multi-tenant conversation engine. A customer messages a rental company on
WhatsApp or Instagram, or rings the showroom and nobody picks up, and this
system answers them, tells them which vehicles are available from that
company's own fleet and rates, quotes a price, holds the car, takes payment,
confirms the booking, and records which bookings it was responsible for.
Fleet and rates are inputs to that conversation. They are not the product.

The code is written, tested and green. 168 tests pass against real Postgres 16
and Redis 7, not mocks. Lint, typecheck and build are clean. CI runs on every
push. What is missing is that it has never run against live channels with real
money. That is the job.

## The stack

Node 20, TypeScript, Express, Prisma, PostgreSQL 16, Redis 7, BullMQ for queues
and delayed jobs, Vitest. `railway.json` and `.github/workflows/ci.yml` are in
the repo. Railway is the documented path, but any host that gives you a
superuser Postgres connection will do. The superuser part matters: see step 2.

## What is already written

1.  **Tenant isolation.** Every table has PostgreSQL row level security with
    `FORCE ROW LEVEL SECURITY`. The application connects as a role that carries
    `NOBYPASSRLS`, so a missing tenant filter returns nothing rather than
    another company's data. Three database roles: `kirmi_migrate` owns the
    schema, `kirmi_app` runs the application, `kirmi_admin` is break glass.
2.  **Tenant resolution from the webhook**, before any query runs. The one
    table outside RLS is `tenant_directory`, because routing has to happen
    before the tenant is known.
3.  **Idempotency** on every inbound webhook, so a replayed delivery cannot
    double book or double charge.
4.  **An append only audit ledger**, enforced by a database trigger. Updates
    and deletes on it raise an exception.
5.  **Availability and holds.** A GiST exclusion constraint over
    `tstzrange(start_at, end_at)` makes double booking the same vehicle
    impossible at the database level. Holds are taken with `SELECT FOR UPDATE
    NOWAIT` so a race fails fast instead of queueing.
6.  **Pricing and quoting**, in integer minor units and basis points. No floats
    anywhere near money.
7.  **The conversation orchestrator** and its tool schema: check availability,
    quote, create hold, send vehicle photos, issue payment link.
8.  **The WhatsApp 24 hour service window.** Inside the window a free form
    message goes out. Outside it, an approved template is used instead. The
    last ten minutes are treated as already closed, because the window shuts on
    Meta's clock and not ours.
9.  **Follow ups** with quiet hours in each client's own timezone, covering
    quote with no reply, hold about to expire, missed call, and reactivation of
    past customers.
10. **Missed call recovery.** A missed call on the Twilio number is turned into
    an inbound message and answered on WhatsApp about a minute later.
11. **SMS fallback** through Twilio for numbers with no WhatsApp.
12. **Payment confirmation.** Stripe payment links, and a Stripe webhook per
    client that confirms the booking when the payment lands. Read the caveat
    below, it is the one open scope question.
13. **Attribution.** The engine decides which bookings the system was
    responsible for, and produces the monthly report the commission is invoiced
    from.
14. **Two screens.** A staff inbox at `/inbox` and a client results page at
    `/dashboard`.
15. **Operational scripts.** `npm run doctor` runs nine preflight checks and
    exits non zero on any failure. `npm run onboard` takes a client JSON file.
    `npm run set-credentials`, `npm run price-check`, `npm run db:issue-key`.

## The one open scope question: the payment processor

The payment confirmation path is **Stripe specific**, not generic. Concretely,
`src/middleware/signature.middleware.ts` parses Stripe's `t=...,v1=...` header,
verifies HMAC-SHA256 over `timestamp.rawBody` with a 300 second replay
tolerance, and `src/routes/webhooks/stripe.routes.ts` handles
`checkout.session.completed`.

If the client uses a different processor, that is a new provider adapter:
different signature scheme, different event names, different payload shape,
different call to create the payment link. The surrounding machinery (tenant
resolution, idempotency, confirming the reservation, cancelling the pending
follow ups) is reused unchanged, and the Stripe implementation is the worked
example to copy, so it is not a rewrite. But it is not zero either, and it is
not the same process.

**Quote it as a separate line item**, conditional on which processor the client
turns out to use. Do not fold it into the fixed price.

## What you do

1.  Provision Postgres 16, Redis 7, an app service and a worker service.
2.  Create the three database roles: `npm run db:roles`, which needs
    `SUPERUSER_DATABASE_URL` pointing at a superuser connection. Then
    `npx prisma migrate deploy`. If your host does not give you a superuser
    connection, say so early, because the role separation is a security
    boundary and is not optional.
3.  Set the environment variables. See `.env.example`. Credentials come
    separately, never in chat.
4.  Register the live webhooks: Meta for WhatsApp Business and Instagram with
    the verify token, Twilio for both SMS and the voice webhook that catches
    missed calls, and the payment processor's webhook scoped per client.
5.  Submit the WhatsApp message templates for approval and wire the approved
    names into the client config. Start this first, it has the longest lead
    time.
6.  Onboard the first client: `npm run onboard` with their JSON file, then
    `npm run set-credentials`, then `npm run db:issue-key`.
7.  Get `npm run doctor` passing all nine checks against production.
8.  Prove it end to end with a real enquiry from a real phone: message in,
    quote out, hold taken, payment link sent, test card paid, booking
    confirmed, and that booking appearing on the dashboard and in the
    attribution report. **This is the acceptance test.**
9.  Confirm both screens load and issue a client API key: the staff inbox at
    `/inbox` and the client results page at `/dashboard`.
10. Set up monitoring and alerting, confirm database backups are on, and write
    a short runbook so someone else can restart this at 3am.

If you find something missing or broken, report it and it will be fixed. Please
do not redesign anything on your own.

## Where a human is genuinely required

Everything else is scripted. These are the parts no script can do, and they are
what you are actually being paid for:

- Meta Business verification and WhatsApp Business phone number registration.
  Bureaucratic, slow, and outside anyone's control. Days, not hours.
- WhatsApp message template submission and approval. Meta reviews them.
- Twilio number purchase, and pointing both its messaging and voice webhooks at
  the right URLs.
- Payment processor account connection and webhook registration.
- Creating the infrastructure and holding the one superuser connection needed
  to run `db:roles` once.
- Putting the real credentials in, once, per client.
- Reading `npm run doctor` output and fixing whatever it names.
- Running the end to end test with a real phone and a real card.
- Monitoring, alerting and backup configuration.

## This has to be repeatable

Client two, client fifty and client one hundred must be the same steps with a
different JSON file, not a fresh project each time. Everything above except the
first two lines of infrastructure provisioning is per client and scripted.

**Please quote for onboarding two clients, not one.** The second one is how we
both find out whether step 6 really is a process.

## Where to start reading

`README.md` for the architecture and the guarantees. `DEPLOY.md` for the
variables and the order they go in. `prisma/schema.prisma` for the data model.
`src/orchestrator/message.pipeline.ts` for how a message becomes a reply.
`tests/integration/payment-confirmation.test.ts` for the money path, including
the bug it was written to prevent.
