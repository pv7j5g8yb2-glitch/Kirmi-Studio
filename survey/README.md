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
- You sign in at `/admin/login` and see every response, finished or not, at `/admin`,
  with an Export CSV button that pulls every answer from every respondent, one row per
  answer, ready to paste in for analysis.

## Adaptive follow-ups

With `ANTHROPIC_API_KEY` unset, follow-ups run in a fixed deterministic mode, useful for
testing the flow end to end without burning API calls. Set `ANTHROPIC_API_KEY` to have
Claude read each respondent's baseline answers and decide, one question at a time,
whether a follow-up is worth asking and what it should be, stopping once pain,
frequency, cost, and willingness to pay are clear or the 10 question cap is hit,
whichever comes first.

## Adding a niche

Add an entry to `src/segments.js`: a slug, the niche name, the intro copy shown before
the first question, and exactly 5 baseline questions. That slug is immediately live at
`/s/<slug>`.

## Storage

SQLite, one file at `DATABASE_FILE` (defaults to `./data/survey.db`). This is built for
dozens to a few hundred respondents, not a production SaaS, so there is no separate
database server to run or pay for.
