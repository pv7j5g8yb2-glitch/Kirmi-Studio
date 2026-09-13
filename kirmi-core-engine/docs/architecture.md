# Architecture

## The shape of the problem

A customer messages a luxury rental company on WhatsApp at 2am. They are
messaging four companies at once. Whoever replies first with a real price,
for a car that is genuinely free, usually gets the booking.

Every hard part of this system falls out of that sentence.

**"Whoever replies first"** is where the 15 second SLA and the Redis context
cache come from. **"A real price"** is why the model is forbidden from
arithmetic. **"Genuinely free"** is why reservations take a pessimistic row
lock. **"Four companies at once"** is why holds expire. And because the same
engine serves several rental companies who compete with each other, tenant
isolation is not a tidiness concern, it is the product's licence to exist.

## Layering

```
   routes/          HTTP surface. Thin. Resolve, verify, persist, enqueue, 200.
        │
   middleware/      Tenant resolution, signature verification, idempotency.
        │           The ORDER of these is the security model.
        ↓
   orchestrator/    The LLM boundary. Parses text into tool calls.
        │           Decides nothing.
        ↓
   services/        Tenant aware domain logic. Every method takes or opens
        │           a tenant scope. This is where transactions live.
        ↓
   core/            STATELESS. Pure functions. Pricing, availability,
        │           qualification, money. No I/O of any kind.
        ↓
   db/ cache/       Infrastructure. The isolation layer lives here.
```

Dependencies point downwards only. `core/` imports nothing from `services/`,
which is what makes it testable in milliseconds and what stops a schema change
altering a price.

## The four boundaries worth arguing about

### Core is pure, and that is not negotiable

`src/core/pricing/pricing.engine.ts` is a function from plain objects to a plain
object. No database handle, no clock, no network. Same inputs, same output,
forever.

This buys three things. The pricing rules can be tested exhaustively rather than
sampled. A stored quote can be recomputed from its own breakdown months later
and proved correct. And a change to the schema cannot silently change what a
customer is charged, because the engine never sees the schema.

### The model parses, the code decides

The three tools exposed to the LLM, `SEARCH_VEHICLES`, `CHECK_AVAILABILITY` and
`CREATE_HOLD`, have no field through which a price could be supplied. Not
because the prompt forbids it: because the schema has nowhere to put one.

A language model asked to price a five day Urus hire with delivery and VAT will
produce a number that looks right, and will be right most of the time. The times
it is not, a client has quoted a customer a figure they cannot honour, in
writing, on WhatsApp. So the model reads "something loud for the weekend, drop
it at the Marina" and turns it into structured arguments, which is what language
models are genuinely good at, and every figure comes from the pricing engine.

There is a test, `tool-schema.test.ts`, that fails if anybody adds a price
shaped field. The guarantee is defended by CI rather than by memory.

### Isolation belongs to the database

See [tenancy.md](tenancy.md). The short version: the application declares which
tenant it is acting as, and PostgreSQL enforces it. The application is not the
thing enforcing isolation, which is why a bug in a service cannot become a data
breach.

### Webhooks acknowledge fast and work slowly

Meta expects a 200 within a couple of seconds and redelivers if it does not get
one. Doing the real work inline means a slow model call turns into duplicate
deliveries, which the idempotency layer then has to clean up.

So the route does only what must be synchronous, verify the signature, claim the
idempotency key, persist the raw event, and returns. Everything else happens on
a queue in a separate process, where a slow step costs latency rather than
correctness.

## The reply pipeline

```
1. resolve customer from their channel handle       (upsert, race safe)
2. open or find the live conversation                (one open thread per channel)
3. check aiEnabled                                   stop here if a human has it
4. load context                                      Redis, Postgres on a miss
5. ask the model                                     it may call tools
6. execute tools                                     real fleet, real locks, real pricing
7. ask the model to phrase the result
8. check aiEnabled AGAIN, inside the writing transaction
9. record the reply, then dispatch it
```

Step 8 is the one people leave out. Seconds pass between step 5 and step 9, and
a human clicking "take over" in that window must stop the agent, not watch it
get one last message in. Reading the flag inside the same transaction that
writes the reply means a concurrent takeover either lands before that read, and
we stand down, or after our commit, and the human sees our last message.

Step 9's ordering matters too. Recorded first, sent second. The other way round,
a crash between the two leaves a customer holding a message the system has no
memory of, and the next reply repeats it or contradicts it.

## The reservation loop

The failure being prevented:

> Two customers message about the same Lamborghini for the same weekend, 90
> milliseconds apart. Both check availability, both see a free car because
> neither has written yet, both write a hold. The client finds out on Friday, at
> the airport, in front of one of them.

The fix is one line, taken before the availability check rather than after:

```sql
SELECT id FROM vehicles WHERE id = $1 FOR UPDATE NOWAIT
```

`FOR UPDATE` serialises the two requests: the second cannot read that row until
the first commits or rolls back, so its check runs against the truth rather than
a stale snapshot.

`NOWAIT` decides how the loser finds out. Without it the second request blocks
until the first finishes, which under contention stacks requests behind each
other and burns the reply budget. With it, Postgres raises `55P03` immediately
and the loser gets a fast rejection it can turn into "that one has just gone,
the Huracan is free those dates" while the customer is still typing.

Losing the race is an ordinary outcome, not an error. The contended customer is
still a customer, and answering in seconds is precisely what lets the engine
offer them the next car before they go elsewhere.

Behind all of it, a GiST exclusion constraint makes an overlapping active
reservation unrepresentable, so a future code path that forgets the lock still
cannot produce a double booking.

## Money

Integer minor units throughout, fils for AED. No float ever touches a price.

This is not fussiness. A float subtotal produces a VAT line that disagrees with
the customer's own arithmetic by a fil, and a customer who spots that on an AED
40,000 invoice stops trusting every other number on the page.

Rates are in basis points for the same reason: 10,000 is exactly 1.0, so a
modifier of one is provably a no-op, and a 5% VAT rate is 500 rather than 0.05.

## What makes it productised

Onboarding a client is `INSERT INTO clients` plus
`INSERT INTO client_configurations`. There is no per client branch anywhere in
`src/`, no client specific route, no feature flag keyed on a tenant.

Everything that varies is a column or a validated JSON field: opening hours,
languages, age minimums and per category overrides, VAT rate, bracket
thresholds, delivery fees and waivers, seasonal modifiers, add-ons, hold and
quote lifetimes, channel credentials, escalation targets and routing, agent tone,
and Kirmi's own commercial terms with that client.

The JSON fields are parsed through zod schemas at the boundary, once, on the way
out of the database. Flexibility without validation is just an outage with extra
steps: a malformed config fails loudly at load with the client's name attached,
rather than surfacing as an `undefined` three frames inside a price calculation
at 9pm on a Friday.
