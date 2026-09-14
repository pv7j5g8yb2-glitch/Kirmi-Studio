# Deploying this

Two processes, one image. Both are required.

| Process | Start command | What breaks without it |
|---|---|---|
| web | `npx prisma migrate deploy && node dist/server.js` | Nothing is received |
| worker | `node dist/queue/workers/index.js` | Messages arrive and **nothing ever replies** |

Forgetting the worker is the most common way this looks broken while appearing
healthy: the web service passes its health check, webhooks return 200, and no
customer ever gets an answer.

`railway.json` configures the web service. The worker is a second service on
the same repository with the start command above and the same variables.

## Variables

Set on both services, identically.

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Postgres, **as `kirmi_app`**, never the owner or a superuser |
| `MIGRATION_DATABASE_URL` | Postgres, as `kirmi_migrate` |
| `REDIS_URL` | Redis |
| `PUBLIC_BASE_URL` | The https address the outside world calls |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `SECRETS_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Losing it makes stored credentials unreadable** |
| `DASHBOARD_API_KEY` | Any long random string |
| `DASHBOARD_ALLOWED_ORIGINS` | `PUBLIC_BASE_URL` |

`DATABASE_URL` pointing at a superuser is the one mistake that causes no error
of any kind and turns off tenant isolation completely. `npm run doctor` checks
it first for that reason.

## Order

```
npm run db:roles        # once, as a superuser, before anything else
npm run prisma:migrate  # creates the tables and the isolation policies
npm run onboard -- onboarding/<client>.json
npm run set-credentials -- <slug> meta-token <token>
npm run price-check -- <slug>    # read this against their real rate card
npm run doctor                   # must be clean before a customer sees it
```

## Two scheduled jobs

Neither is optional. Enqueue both every 5 minutes.

- `hold-sweeper` — releases expired holds. Without it, cars stay off the market.
- `follow-up-sweeper` — chases quiet customers. Without it, conversion stays exactly where it was.
