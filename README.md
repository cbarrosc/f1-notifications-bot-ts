# f1-notifications-bot-ts

TypeScript reimplementation of the F1 notifications bot for Supabase Edge Functions.

## Current status

This repository already includes:

- a Supabase Edge Functions-compatible structure
- a `domain`, `application`, `ports`, `adapters`, and `entrypoints` split
- the Telegram webhook
- `/start`, `/subscribe`, `/unsubscribe`, and `/set_country` commands
- inline subscription and timezone callbacks
- `weekly_digest`, `session_reminder`, and `post_race_briefing` wake-up triggers
- integrations with Supabase, the Telegram Bot API, and OpenF1

The implementation is intended to be run from WSL from the repository root, for example:

```bash
cd /path/to/f1-notifications-bot-ts
```

## Structure

```text
supabase/
  config.toml
  functions/
    deno.json
    _shared/
      adapters.ts
      application.ts
      domain.ts
      entrypoints.ts
      env.ts
      ports.ts
      responses.ts
      telegram.ts
    telegram-webhook/
      index.ts
    wake-up/
      index.ts
```

## Required environment variables

Copy `supabase/.env.example` to `supabase/.env.local` for local development.

- `APP_SUPABASE_URL`
- `APP_SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_TOKEN`
- `SECRET_TOKEN`
- `OPENF1_BASE_URL`
- `DISABLE_WEEKLY_DIGEST_WINDOW`
- `DISABLE_SESSION_REMINDER_WINDOW`
- `DISABLE_POST_RACE_BRIEFING_WINDOW`

For local development, the project prefers `APP_SUPABASE_URL` and
`APP_SUPABASE_SERVICE_ROLE_KEY` to avoid conflicts with the reserved
`SUPABASE_*` variables used by `supabase functions serve`.

For hosted Supabase deployments, the runtime can also fall back to the
platform-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Required tools

- `deno`
- `supabase` CLI
- `npm`

## Code linting

Run these commands from WSL to validate the Edge Functions source:

```bash
npm run lint
npm run test
npm run fmt:check
```

To auto-format the functions code:

```bash
npm run fmt
```

## Semantic versioning

This repository uses `semantic-release` to version the project automatically from
Conventional Commits pushed to `main`.

What happens on every push to `main`:

- commit messages are analyzed
- the next semantic version is calculated
- a Git tag is created
- a GitHub Release is published

Examples:

```text
fix: handle OpenF1 429 retries
feat: add weekly digest window bypass
feat!: rename wake-up trigger payload contract
```

Versioning rules:

- `fix:` produces a patch release
- `feat:` produces a minor release
- `!` or a `BREAKING CHANGE:` footer produces a major release

Bootstrap rule for this repository:

- the first production-ready version should be tagged manually as `v0.1.0`
- before that first tag exists, the release workflow intentionally skips `semantic-release`
- after `v0.1.0` exists on `main`, versioning continues automatically from there

If you want to preview the next release and changelog calculation locally from Conventional Commits before a release:

```bash
npm run release:preview
```

GitHub Releases are the source of truth for generated release notes in production.
`CHANGELOG.md` is a lightweight pointer to GitHub Releases, not an auto-generated commit-by-commit changelog.

The workflow is defined in
[`release.yml`](.github/workflows/release.yml).

## Branch strategy

Recommended workflow for this repository:

- `main`: production only, protected, no direct pushes
- `develop`: integration branch for day-to-day work
- `feat/*`, `fix/*`, `chore/*`, `refactor/*`: short-lived branches created from `develop`
- `hotfix/*`: emergency branches created from `main`, then merged back into both `main` and `develop`

Suggested flow:

1. Create a work branch from `develop`
2. Open a PR into `develop`
3. Validate changes in `develop`
4. Open a PR from `develop` into `main` when you want to release
5. Let GitHub Actions deploy and version the project after merge to `main`

This repository includes a CI workflow at
[`ci.yml`](.github/workflows/ci.yml)
that runs on PRs to `develop` and `main`, and on direct pushes to `develop`.

With a single hosted Supabase environment, the recommended policy is:

- `develop`: CI only
- `main`: CI, semantic versioning, and deployment

That means `develop` should not deploy to Supabase while the project still has
only one hosted environment.

## Scheduled wake-up dispatch

The hosted `wake-up` function is triggered by the GitHub Actions workflow
[`scheduled-triggers.yml`](.github/workflows/scheduled-triggers.yml).

It uses the production function URL and bearer token from repository secrets:

- `APP_SUPABASE_URL`
- `SECRET_TOKEN`

Default schedule:

- every Monday at `16:00 UTC`: dispatch `weekly_digest`
- every 15 minutes from Thursday to Monday (`4,5,6,0,1`): dispatch `session_reminder` and `post_race_briefing`

This intentionally relies on the backend use cases to decide whether they are
inside or outside the send window. That keeps the scheduler simple and makes it
safer across time zones and unusual race weekends.

You can also trigger it manually from GitHub Actions with `workflow_dispatch`
and choose one trigger or `all`.

## Commit convention

This repository enforces Conventional Commits through a Git `commit-msg` hook.
It also blocks local commits when Deno linting or formatting checks fail through a Git `pre-commit` hook.

After cloning the repository, install dependencies once to activate Husky:

```bash
npm install
```

Example valid commit messages:

```text
feat: add weekly digest window guard
fix: avoid duplicate subscribe confirmation for active users
chore: add supabase deployment workflow
```

## Run locally

1. Create the local environment file:

```bash
cp supabase/.env.example supabase/.env.local
```

2. Fill `supabase/.env.local` with real credentials.

3. Start the Telegram function:

```bash
supabase functions serve telegram-webhook --env-file supabase/.env.local
```

4. In another WSL terminal, start the wake-up function:

```bash
supabase functions serve wake-up --env-file supabase/.env.local
```

Supabase usually exposes them at URLs like:

- `http://127.0.0.1:54321/functions/v1/telegram-webhook`
- `http://127.0.0.1:54321/functions/v1/wake-up`

## Test the Telegram webhook

Example `/start` command:

```bash
curl -i \
  -X POST http://127.0.0.1:54321/functions/v1/telegram-webhook \
  -H 'content-type: application/json' \
  -d '{
    "update_id": 1001,
    "message": {
      "message_id": 10,
      "text": "/start",
      "chat": { "id": 123456 },
      "from": {
        "id": 123456,
        "first_name": "John",
        "username": "john_doe"
      }
    }
  }'
```

Example subscribe callback:

```bash
curl -i \
  -X POST http://127.0.0.1:54321/functions/v1/telegram-webhook \
  -H 'content-type: application/json' \
  -d '{
    "update_id": 1002,
    "callback_query": {
      "id": "cb-1",
      "data": "subscribe_cta",
      "from": {
        "id": 123456,
        "first_name": "John",
        "username": "john_doe"
      },
      "message": {
        "message_id": 11,
        "chat": { "id": 123456 }
      }
    }
  }'
```

Example timezone callback:

```bash
curl -i \
  -X POST http://127.0.0.1:54321/functions/v1/telegram-webhook \
  -H 'content-type: application/json' \
  -d '{
    "update_id": 1003,
    "callback_query": {
      "id": "cb-2",
      "data": "tz_cl",
      "from": {
        "id": 123456,
        "first_name": "John",
        "username": "john_doe"
      },
      "message": {
        "message_id": 12,
        "chat": { "id": 123456 }
      }
    }
  }'
```

## Test wake-up

Example `weekly_digest` request:

```bash
curl -i \
  -X POST http://127.0.0.1:54321/functions/v1/wake-up \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SECRET_TOKEN" \
  -d '{
    "trigger_type": "weekly_digest"
  }'
```

Example `session_reminder` request:

```bash
curl -i \
  -X POST http://127.0.0.1:54321/functions/v1/wake-up \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SECRET_TOKEN" \
  -d '{
    "trigger_type": "session_reminder"
  }'
```

Example `post_race_briefing` request:

```bash
curl -i \
  -X POST http://127.0.0.1:54321/functions/v1/wake-up \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SECRET_TOKEN" \
  -d '{
    "trigger_type": "post_race_briefing"
  }'
```

## Important implemented rules

- `session_reminder` uses `bot_settings.alert_lead_time`
- `weekly_digest` only sends when the next Race is 7 days away or less
- `post_race_briefing` is only built when a completed Race exists
- `post_race_briefing` uses `bot_settings.post_race_delta`
- `DISABLE_WEEKLY_DIGEST_WINDOW=true` bypasses the weekly digest window check
- `DISABLE_SESSION_REMINDER_WINDOW=true` bypasses the reminder window check
- `DISABLE_POST_RACE_BRIEFING_WINDOW=true` bypasses only the completed-race window enforcement in the provider

## Troubleshooting checklist

- the `users` table must contain `user_id`, `first_name`, `username`, `status`, and `timezone`
- the `bot_settings` table must contain `key` and `value`
- at minimum, the following settings must exist: `welcome_msg`, `already_registered`, `already_registered_msg`, `subscribe_ok`, `unsubscribe_ok`, `set_country_msg`, `timezone_confirmation_text`, `weekly_summary_msg`, `session_reminder_msg`, `post_race_briefing_msg`, `alert_lead_time`, and `post_race_delta`
- `TELEGRAM_TOKEN` and `APP_SUPABASE_SERVICE_ROLE_KEY` must be valid
- OpenF1 must be reachable from the function runtime
- the `notification_deliveries` table must exist so wake-up notifications can be deduplicated per user

## Production deployment

Pushes to `main` can deploy all Edge Functions automatically through
[`deploy-functions.yml`](.github/workflows/deploy-functions.yml).

The workflow uses the official Supabase CLI GitHub Action and deploys all
functions with:

```bash
supabase functions deploy --project-ref "$SUPABASE_PROJECT_ID" --use-api
```

Set these GitHub Actions secrets in the repository before enabling the workflow:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_ID`
- `TELEGRAM_TOKEN`
- `SECRET_TOKEN`

Optional GitHub Actions secrets:

- `OPENF1_BASE_URL`
- `DISABLE_WEEKLY_DIGEST_WINDOW`
- `DISABLE_SESSION_REMINDER_WINDOW`
- `DISABLE_POST_RACE_BRIEFING_WINDOW`

The workflow also syncs the runtime secrets to the hosted Supabase project using
`supabase secrets set`, so the deployed Edge Functions have the values they need
without depending on your local `.env.local`.

No deployment is triggered from `develop`. The intended release flow is:

1. Merge feature branches into `develop`
2. Let CI validate the integration branch
3. Open a PR from `develop` into `main`
4. Merge into `main` to trigger semantic release and Supabase deployment
