# Kirmi Platform

The inbound sales and booking department for vehicle-rental companies. Multi-tenant;
DEIZ Rental Dubai is the first reference configuration.

The product is the **message loop**, not the dashboard. The web console is an operations
tool for staff.

## Run it

```bash
npm install

# Postgres 16. Migrations run as the OWNER; the app connects as kirmi_app.
DATABASE_URL='postgresql://kirmi@/kirmi?host=/tmp&port=5433' npm run migrate

# seed the reference client and an isolated demo tenant
SEED_ADMIN_PASSWORD='...' SEED_CLIENT_PASSWORD='...' npx tsx src/db/seed-deiz.ts
SEED_DEMO_PASSWORD='...'  npx tsx src/db/seed-demo.ts

cp .env.example .env    # then fill in what you have
npm run dev             # console + API + webhooks on :3000
```

Console at `/`. Health at `/healthz`.

## Verify the loop without any credentials

```bash
npm test                          # 73 tests against a real database
npx tsx src/jobs/run-tick.ts      # drain outbox, run follow-ups, expire holds
```

To watch a message go end to end, send a signed webhook to `/webhooks/whatsapp` — see
`docs/integrations.md` for the payload shape, and `tests/webhook.test.ts` for a worked example.

## Layout

```
src/
  config/     env parsing and validation (the only place secrets enter)
  db/         schema, migrations, tenant-scoped connections, seeds
  core/       money, auth, audit, integration registry, errors
  domain/     vehicles, availability, pricing, quotes, reservations,
              documents, payments, follow-ups, reporting, outbox
  channels/   WhatsApp / Instagram providers and webhook parsers
  engine/     NLU, tool layer, orchestrator, ingest
  api/        HTTP routes and webhook endpoints
  jobs/       scheduler
  web/        operator console (static, dependency-free)
docs/         architecture · database · integrations · testing · production-readiness
```

## The rules this code enforces

- Availability is never asserted without an authoritative source.
- A booking is confirmed only by a payment provider, a named operator, or an external system.
- Cash and crypto can never be marked `paid` — only `confirmed_by_staff`.
- Money is integer fils; floats never touch a quote.
- Anything the engine cannot answer truthfully escalates to a person.
- BUILT is not CONNECTED, and the console says which is which.
