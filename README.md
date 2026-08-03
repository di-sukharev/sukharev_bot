# Sukharev Bot

Telegram community bot for moderation and a lightweight reputation score called
“vibe”. It runs as a Cloudflare Worker, receives Telegram updates through a
webhook, stores state in Cloudflare D1, and uses a Cloudflare Queue as a fallback
for delayed notification cleanup.

The project is distributed under the [Apache License 2.0](LICENSE).

## Features

- welcomes new chat members and publishes chat rules;
- limits links to trusted domains, protected users, or members with enough vibe;
- removes configured profanity and applies negative vibe;
- awards and rolls back vibe for thanks replies and Telegram reactions;
- deletes messages after repeated negative reactions and bans users below the
  configured moderation threshold;
- provides `/chatid`, `/rules`, `/vibe`, and `/vibe_top` commands;
- processes Telegram updates idempotently through D1 reservations.

The bot is intentionally project-specific. Moderation thresholds, Russian copy,
the profanity list, and the allowed main Telegram channel live in
[`src/bot.ts`](src/bot.ts) and [`src/vibe.ts`](src/vibe.ts).

## Requirements

- [Bun](https://bun.sh/) 1.3.11 or newer;
- a Telegram bot created with BotFather;
- a Cloudflare account with Workers, D1, and Queues enabled.

## Local setup

```bash
bun install
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`, then update the non-secret resource configuration in
`wrangler.toml`. Both files are ignored because the operational configuration
contains bot, chat, user, and Cloudflare resource identifiers. Their checked-in
examples are safe to publish.

Apply migrations and start the Worker:

```bash
bun run d1:migrate:local
bun run dev
```

The Worker exposes:

- `GET /health` — health check;
- `POST /telegram/webhook` — Telegram webhook protected by
  `X-Telegram-Bot-Api-Secret-Token`.

## Configuration

Secrets belong in `.dev.vars` locally and in Cloudflare Worker secrets in
production:

- `BOT_TOKEN` — BotFather token;
- `TELEGRAM_WEBHOOK_SECRET` — random webhook authentication secret.

Runtime variables belong in `wrangler.toml`:

- `ALLOWED_CHAT_IDS` — comma-separated chat IDs;
- `OWNER_USER_IDS` — protected Telegram user IDs;
- `BOT_INFO` — Telegram `getMe` result object encoded as JSON;
- `ANNOUNCE_REACTIONS` — whether reaction vibe changes are announced;
- `WELCOME_MUTED_UNTIL` — optional ISO timestamp that pauses welcome messages;
- `LINK_ALLOWED_USERNAMES` — usernames allowed to bypass link moderation.

Webhook setup additionally reads:

- `TELEGRAM_WEBHOOK_URL` — public HTTPS URL ending in `/telegram/webhook`;
- `TELEGRAM_WEBHOOK_ALLOWED_HOST` — exact host allowed by the setup guard;
- `TELEGRAM_DROP_PENDING_UPDATES` — optional boolean for intentionally dropping
  pending Telegram updates.

Never commit `.dev.vars` or the live `wrangler.toml`.

## Cloudflare setup

Create one D1 database and one Queue, then copy the returned D1 ID and the chosen
resource names into `wrangler.toml`:

```bash
bunx wrangler d1 create sukharev-community-bot
bunx wrangler queues create sukharev-community-bot-vibe-notification-deletes
```

Set production secrets:

```bash
bunx wrangler secret put BOT_TOKEN
bunx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Get `BOT_INFO` from Telegram and place only the response `result` object into
`wrangler.toml`:

```bash
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getMe"
```

The production preflight rejects the placeholder bot identity and invalid
welcome timestamps.

## Telegram setup

Add the bot to the group as an administrator. Reading messages, member updates,
and reactions is required for normal operation. Link and profanity moderation
requires `can_delete_messages`; automatic low-vibe bans require
`can_restrict_members`.

After deployment, use `/chatid` to discover the target chat ID. Add it to
`ALLOWED_CHAT_IDS`, redeploy, then set the webhook:

```bash
bun run webhook:set
```

The setup script registers `message`, `edited_message`, `channel_post`,
`edited_channel_post`, `chat_member`, `message_reaction`, and
`message_reaction_count` updates with one Telegram connection. It refuses to
mutate the webhook from a dirty Git tree.

## Development and release

```bash
bun run check
bun test
bun run d1:migrate:local
bunx wrangler deploy --dry-run
```

Production operations:

```bash
bun run d1:migrate:prod
bun run deploy
bun run webhook:set
```

Production migrations, deploys, and webhook changes refuse dirty Git trees.
Review `git status --short --branch` and commit the intended tree first. D1
migrations are append-only SQL files in `drizzle/migrations`.

## License

Copyright 2026 Dima Sukharev.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
