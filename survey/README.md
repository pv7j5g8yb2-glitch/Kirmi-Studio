# Kirmi Survey

A small, self-contained tool for the PMF research survey. Separate from `platform/`,
which is the DEIZ booking engine, this has nothing to do with that.

A respondent opens a link for their niche, answers 5 baseline questions that are the
same for everyone in that niche, then gets adaptive follow-up questions tuned to their
own answers. The whole thing is capped at 10 questions. If someone starts and never
finishes, the exact question number and text they were sitting on when they stopped is
recorded, so drop-off is never a guess.

## Run it

```bash
npm install
cp .env.example .env    # set COOKIE_SECRET and ADMIN_PASSWORD
npm run dev             # survey + admin on :3100
```

- Send a respondent to `/s/bookkeepers` or `/s/real-estate-agents`.
- You sign in at `/admin/login` with whatever you set `ADMIN_PASSWORD` to in `.env`,
  there is no separate account to create. `/admin` then lists every response, finished
  or not, with an Export CSV button that pulls every answer from every respondent, one
  row per answer, ready to paste in for analysis.

This only runs on your own machine or wherever you deploy it, there is no public link
until you put it somewhere reachable from the internet. For a real send-out you need a
host with a persistent disk, since the whole thing is one SQLite file: Fly.io's free
tier includes a small persistent volume, which is the cheapest option that will not
silently wipe responses on a restart. Render and Railway's free tiers are ephemeral
disk, fine for poking at it, not for collecting real answers.

### Tagging who a link went to

Add `?ref=` to any link you send, for example `/s/bookkeepers?ref=ig_jane_doe`. That
value is stored on the response with no extra step for the respondent, so you can match
a finished survey straight back to the WhatsApp or Instagram contact you sent it to,
without asking them to re-type a phone number or email into a form that is meant to
read as pure research. `/admin` shows the ref on every row.

## Adaptive follow-ups

With `ANTHROPIC_API_KEY` unset, follow-ups run in a fixed deterministic mode, useful for
testing the flow end to end without burning API calls. Set `ANTHROPIC_API_KEY` to have
Claude read each respondent's baseline answers and decide, one question at a time,
whether a follow-up is worth asking and what it should be, stopping once pain,
frequency, cost, and willingness to pay are clear or the 10 question cap is hit,
whichever comes first.

### Optional contact capture

After the last question, the respondent sees one optional step asking if they would
take a follow-up by phone or email, with a Skip button right next to it. It only
appears once the survey is actually finished, so it never costs you a completion, and
it is there mainly for whoever forwards the link to someone you have not DMed
yourself, where a `ref` tag alone will not identify them.

## Adding a niche

Add an entry to `src/segments.js`: a slug, the niche name, the intro copy shown before
the first question, and exactly 5 baseline questions. That slug is immediately live at
`/s/<slug>`.

## Storage

SQLite, one file at `DATABASE_FILE` (defaults to `./data/survey.db`). This is built for
dozens to a few hundred respondents, not a production SaaS, so there is no separate
database server to run or pay for.
