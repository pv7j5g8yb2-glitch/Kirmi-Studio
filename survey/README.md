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
  there is no separate account to create, and that sign-in stays good for about 400
  days (the longest a browser will actually honour), not 12 hours. `/admin` then lists
  every response, finished or not, with an Export CSV button that pulls every answer
  from every respondent, one row per answer, ready to paste in for analysis.

This only runs wherever something is actually running it. `localhost` only ever means
"this machine", your phone trying to open your laptop's `localhost` link will always
fail, that is not a bug. See **Going live** below for getting a real link.

### Tagging who a link went to

Add `?ref=` to any link you send, for example `/s/bookkeepers?ref=+353871234567`
(their WhatsApp number, or whatever you use to track them in your own outreach list).
That value is stored on the response with no extra step for the respondent, so you can
match a finished survey straight back to the contact you sent it to, without asking
them to re-type a phone number or email into a form that is meant to read as pure
research. `/admin` has a small "Make a tagged link to send someone" box at the top that
builds this URL for you, so you never have to hand-type the query string, and it shows
the ref on every row of the response list.

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

### First name and the "Hello" moment

After they click Start, there is one quick "what should I call you" step with a Skip
link right there. If they give a name, they see a brief animated "Hello, Name" before
the first question, then every answer screen and the thank-you at the end uses it.
Skipping costs nothing, it just goes straight to Q1 with no animation.

## Adding a niche

Add an entry to `src/segments.js`: a slug, the niche name, the intro copy shown before
the first question, and exactly 5 baseline questions. That slug is immediately live at
`/s/<slug>`, and it shows up automatically in the link generator on `/admin`.

## Storage

SQLite, via `@libsql/client`, which speaks the exact same SQL whether it is pointed at
a local file or a hosted database, so the code never changes between testing and real
use, only the `DATABASE_URL` in `.env`.

- **Local testing:** leave `DATABASE_URL` blank, it defaults to a file at
  `./data/survey.db` on your own machine.
- **Real use:** point it at a hosted database instead, see **Going live** below. A local
  file does not survive a redeploy or a restart on most free hosts, so do not rely on it
  for anything you cannot afford to lose.

## Going live, free, no domain to buy

Two separate pieces, and conflating them is the usual mistake: where the **data**
lives, and where the **app** runs. Get both right and you have a real `https://...`
link to send out, with nothing bought.

**Netlify will not work here**, worth saying plainly since it is the obvious guess.
Netlify runs static sites and short-lived serverless functions, it has no persistent
server process and no filesystem to keep a database in. This app is a long-running
Fastify server that remembers state between requests, which is a different shape of
thing to what Netlify hosts.

**1. The data: [Turso](https://turso.tech)** (genuinely free, no card, 5GB, built on
SQLite so nothing in this codebase changes). Sign up, create a database, and it gives
you a `libsql://...` URL and an auth token. Put those in `.env` (or your host's
environment variables) as `DATABASE_URL` and `DATABASE_AUTH_TOKEN`. Now your survey
responses live somewhere durable no matter what happens to the app container.

**2. The app: [Render](https://render.com)**, free web service. It gives you a
`your-app-name.onrender.com` link automatically, no domain purchase involved. Push this
repo to GitHub, connect it on Render, set the root directory to `survey`, build command
`npm install`, start command `npm start`, and add the same environment variables from
your `.env` (`COOKIE_SECRET`, `ADMIN_PASSWORD`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`,
and `ANTHROPIC_API_KEY` if you are using live follow-ups). Render's free tier spins the
app down after 15 minutes with no traffic, so the first click on a link after a quiet
spell takes a few extra seconds to wake back up, everything after that is instant. That
is a real trade-off for free, not a bug, and it is fine for a research survey that gets
opened a handful of times a day. Render has recently started asking some free signups
for a card for anti-fraud verification, it is a $1 hold that gets refunded, not a
subscription, but it is worth knowing before you start the signup rather than part way
through it.

Hosting's free tiers shift often (Fly.io dropped its free tier entirely in the past
year, for one), so if Render's terms have changed by the time you read this, Koyeb is
the other option worth a look, same idea: free web service, no domain needed, confirm
the current card policy on their pricing page before committing.
