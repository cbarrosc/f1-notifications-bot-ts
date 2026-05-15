# C4 Architecture

This document describes the F1 Notifications Bot architecture using the C4 model.

## Level 1: System Context

The F1 Notifications Bot helps Telegram users subscribe to Formula 1 notifications. It receives commands and callbacks from Telegram, stores user preferences in Supabase, reads race data from OpenF1, and sends scheduled reminders back through Telegram.

```mermaid
flowchart LR
  user[Telegram User] -->|Sends commands and callback actions| telegram[Telegram Bot API]

  telegram -->|Webhook update| bot[F1 Notifications Bot]

  bot -->|Reads sessions and race data| openf1[OpenF1 API]
  bot -->|Stores users, queue items, and delivery state| supabase[Supabase]
  bot -->|Sends notification messages| telegram

  cron[Supabase pg_cron] -->|Triggers scheduled notification jobs| bot
```

### External Systems

- **Telegram Bot API**: receives user interactions and delivers bot messages.
- **OpenF1 API**: provides Formula 1 session and race data.
- **Supabase**: hosts Edge Functions, Postgres, and scheduled jobs.
- **GitHub Actions**: validates, releases, and deploys the project.

## Level 2: Containers

The system is implemented as Supabase Edge Functions written in TypeScript and running on Deno. Persistent state lives in Supabase Postgres, while `pg_cron` owns the production notification schedule.

```mermaid
flowchart TB
  user[Telegram User]
  telegram[Telegram Bot API]
  openf1[OpenF1 API]

  subgraph supabase[Supabase Project]
    edge[Edge Functions - Deno / TypeScript]
    db[(Postgres Database)]
    cron[pg_cron Scheduler]
  end

  subgraph github[GitHub]
    repo[Repository]
    actions[GitHub Actions]
  end

  user -->|Commands and inline actions| telegram
  telegram -->|Webhook requests| edge

  cron -->|Scheduled HTTP calls| edge

  edge -->|Supabase JS service role access| db
  edge -->|HTTP requests| openf1
  edge -->|sendMessage API calls| telegram

  repo --> actions
  actions -->|Lint, test, and format checks| edge
  actions -->|Deploy functions| edge
  actions -->|semantic-release tags and releases| repo
```

### Containers

- **Edge Functions**: HTTP entrypoints for Telegram webhooks, manual wake-up triggers, planning jobs, and dispatching jobs.
- **Postgres Database**: stores users, notification delivery markers, cached F1 sessions, queued notifications, and delivery logs.
- **pg_cron Scheduler**: periodically invokes the planner and dispatcher functions.
- **GitHub Actions**: runs CI, deploys Supabase functions, and publishes semantic releases.

## Level 3: Edge Function Components

The Edge Functions share a layered internal structure: entrypoints parse HTTP requests, application services coordinate use cases, domain modules hold business rules, ports define interfaces, and adapters connect to external systems.

```mermaid
flowchart TB
  telegram[Telegram Bot API]
  openf1[OpenF1 API]
  db[(Supabase Postgres)]
  cron[pg_cron Scheduler]

  subgraph functions[Supabase Edge Functions]
    webhook[telegram-webhook]
    wakeup[wake-up]
    planner[fn-planner-v2]
    dispatcher[fn-dispatcher-v2]
  end

  subgraph shared[Shared Function Modules]
    entrypoints[entrypoints.ts / v2-entrypoints.ts]
    application[application.ts / v2-application.ts]
    domain[domain.ts / v2-domain.ts]
    ports[ports.ts / v2-ports.ts]
    adapters[adapters.ts / v2-adapters.ts]
    env[env.ts]
    responses[responses.ts]
    telegram_helpers[telegram.ts]
  end

  telegram -->|Webhook updates| webhook
  cron -->|Scheduled planner calls| planner
  cron -->|Scheduled dispatcher calls| dispatcher

  webhook --> entrypoints
  wakeup --> entrypoints
  planner --> entrypoints
  dispatcher --> entrypoints

  entrypoints --> env
  entrypoints --> responses
  entrypoints --> telegram_helpers
  entrypoints --> application

  application --> domain
  application --> ports
  ports --> adapters

  adapters -->|Users, notification queue, delivery logs, session cache| db
  adapters -->|Session and race data| openf1
  adapters -->|Outbound messages| telegram
```

### Function Responsibilities

- **telegram-webhook**: receives Telegram updates, handles `/start`, `/subscribe`, `/unsubscribe`, `/set_country`, subscription callbacks, and timezone/country callbacks.
- **wake-up**: supports legacy or manual notification triggers such as `weekly_digest`, `session_reminder`, and `post_race_briefing`.
- **fn-planner-v2**: reads upcoming F1 sessions from OpenF1, caches session data, and creates notification queue items.
- **fn-dispatcher-v2**: claims due notification queue items, resolves recipients, sends Telegram messages, and records delivery results.

### Data Stores

- **users**: Telegram users, subscription status, profile information, and timezone preference.
- **notification_deliveries**: legacy idempotency log for sent notifications.
- **f1_sessions_cache**: cached OpenF1 session data used by the v2 pipeline.
- **notification_queue**: scheduled notification items waiting to be dispatched.
- **delivery_logs**: per-user delivery attempts and results for queued notifications.

## Main Runtime Flows

### Telegram Interaction Flow

```mermaid
sequenceDiagram
  participant User as Telegram User
  participant Telegram as Telegram Bot API
  participant Webhook as telegram-webhook
  participant App as Telegram Use Case
  participant DB as Supabase Postgres

  User->>Telegram: Sends command or taps inline action
  Telegram->>Webhook: Sends webhook update
  Webhook->>App: Parses update and invokes use case
  App->>DB: Reads or updates user preferences
  App->>Telegram: Sends response message
```

### Notification Pipeline V2 Flow

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant Planner as fn-planner-v2
  participant OpenF1 as OpenF1 API
  participant DB as Supabase Postgres
  participant Dispatcher as fn-dispatcher-v2
  participant Telegram as Telegram Bot API

  Cron->>Planner: Trigger planning job
  Planner->>OpenF1: Fetch upcoming race weekend data
  Planner->>DB: Cache sessions and upsert queue items

  Cron->>Dispatcher: Trigger dispatching job
  Dispatcher->>DB: Claim due queue items
  Dispatcher->>DB: Load active users and delivery state
  Dispatcher->>Telegram: Send notification messages
  Dispatcher->>DB: Record delivery logs and queue status
```

## Deployment and Operations

```mermaid
flowchart LR
  dev[Developer] -->|Pushes commits / opens PR| repo[GitHub Repository]
  repo --> ci[CI Workflow]
  ci -->|Deno lint| lint[Lint]
  ci -->|Deno test| test[Test]
  ci -->|Deno fmt --check| fmt[Format Check]

  repo --> release[Release Workflow]
  release -->|semantic-release| github_release[GitHub Release]

  repo --> deploy[Deploy Supabase Functions Workflow]
  deploy -->|Sync runtime secrets| secrets[Supabase Secrets]
  deploy -->|Deploy Edge Functions| functions[Supabase Edge Functions]
```

The `develop` branch is intended for integration and CI validation. The `main` branch is intended for production releases and Supabase deployment.
