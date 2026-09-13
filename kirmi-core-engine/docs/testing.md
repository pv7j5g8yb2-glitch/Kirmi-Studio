# Testing

```bash
npm test                  # everything
npm run test:unit         # pure logic, no infrastructure, about 100ms
npm run test:integration  # real Postgres and Redis
```

Integration tests skip cleanly when no database is reachable, so `npm test`
works on a laptop with nothing running. They do not silently pass: they report
as skipped.

## The split

**Unit tests** cover `src/core/`, which is pure by construction: no database
handle, no clock of its own, no network. Pricing, availability, qualification,
signature verification, the tool schemas. They run in milliseconds from object
literals, which means the rules that decide what a customer is charged can be
tested exhaustively rather than sampled.

**Integration tests** cover the properties that belong to the database and the
cache rather than to the code: row level security, pessimistic row locks, atomic
claim semantics, end to end latency. These run against a real PostgreSQL with
the real migrations applied, because mocking a row lock proves only that the
mock agrees with itself.

## What is proved

| Claim | Test | Method |
|---|---|---|
| Tenants cannot see each other | `tenant-isolation.test.ts` | 12 assertions against real RLS policies, including unfiltered queries and raw SQL |
| The tenant setting does not leak between pooled connections | `tenant-isolation.test.ts` | reads the GUC on a fresh connection after a scoped transaction commits |
| One car cannot be sold twice | `reservation-race.test.ts` | 8 genuinely concurrent transactions; exactly one wins |
| The loser finds out fast | `reservation-race.test.ts` | asserts rejection under 2s while a real lock is held |
| The lock is per vehicle, not global | `reservation-race.test.ts` | two cars held simultaneously |
| The constraint holds even without the lock | `reservation-race.test.ts` | raw INSERT bypassing the service is refused |
| Duplicate webhooks are dropped | `idempotency.test.ts` | 20 concurrent claims on one id; exactly one wins |
| A failed job releases its claim | `idempotency.test.ts` | a retry after release is allowed through |
| Signature verification actually verifies | `signature.test.ts` | tampered bodies, wrong secrets, missing headers, re-serialised JSON |
| Unsigned requests cannot claim idempotency keys | `webhook-http.test.ts` | asserts middleware ordering through the real HTTP stack |
| Replies land inside the 15s SLA | `sla.test.ts` | full pipeline, measured from carrier receipt |
| Queue time counts against the SLA | `sla.test.ts` | a message delayed 20s is flagged as a breach |
| The warm path is faster than the cold one | `sla.test.ts` | the justification for the Redis layer |
| A human takeover silences the agent mid flight | `escalation.test.ts` | takeover lands while the model is still generating |
| Under age drivers are never quoted | `escalation.test.ts` | asserts zero quotes and zero outbound messages |
| The ledger cannot be rewritten | `metrics.test.ts` | UPDATE and DELETE both refused by the database |
| A retried payment does not double count | `metrics.test.ts` | same reference twice, one booking |
| Fees use the terms in force at the time | `metrics.test.ts` | commission renegotiated after the fact, historic figure unchanged |
| The model has no way to invent a price | `tool-schema.test.ts` | structural: no schema field could carry one |

## The SLA test, specifically

Latency is measured from **carrier receipt**, not from when the pipeline
function was entered. A message that waited eleven seconds in a queue and was
answered in two took thirteen seconds as far as the customer is concerned, and
thirteen is the number the client was promised something about.

The model is scripted rather than live, for two reasons. It makes the
measurement reproducible, and it measures what is actually ours: a reply that
took eleven seconds because a provider was slow is worth knowing about, but it
is not a regression in this codebase. The scripted client takes a configured
delay standing in for the provider, and the rest of the pipeline is measured
honestly against the remaining budget.

## The tool schema test, specifically

`tool-schema.test.ts` is structural rather than behavioural, and that is the
point. Prompt instructions can be argued with by a sufficiently confident model.
A schema with no field for a price gives it nowhere to put one.

The test walks every tool's input schema and fails if any field name looks like
a price, a total, or an availability assertion. If somebody later adds a
`totalPrice` argument because it would be convenient, CI refuses it, and the
grounding guarantee is defended by a test rather than by whoever reviews the PR.

## Running against your own infrastructure

```bash
DATABASE_URL=postgresql://kirmi_app:...@host/kirmi_test \
MIGRATION_DATABASE_URL=postgresql://kirmi_migrate:...@host/kirmi_test \
REDIS_URL=redis://host:6379 \
npm run test:integration
```

The harness applies migrations itself and truncates between tests. Point it at a
throwaway database: it will `TRUNCATE ... CASCADE` every tenant table.
