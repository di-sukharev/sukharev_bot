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
- deletes messages with 3 or more active 💩/👎 reactions combined;
- permanently bans users at −10 vibe or below and requests deletion of all their
  messages in the same chat via Telegram's `revoke_messages` option;
- provides `/chatid`, `/rules`, `/vibe`, and `/vibe_top` commands;
- processes Telegram updates idempotently through D1 reservations.

The bot is intentionally project-specific. Moderation thresholds, Russian copy,
the profanity list, and the allowed main Telegram channel live in
[`src/bot.ts`](src/bot.ts) and [`src/vibe.ts`](src/vibe.ts).

Protected users in `OWNER_USER_IDS` are exempt from reaction-based deletion and
low-vibe bans. Automatic bans also exempt `@haltmachina`, chat administrators,
and the chat creator. Before banning, the bot checks the current Telegram role
and only bans regular members or restricted users who are still members.
Identifiable self-reactions do not count. Moderation runs when new
updates arrive; existing messages and completed bans are not rescanned.

For identifiable reaction actors, negative reactions can deduct at most one
vibe per actor/recipient pair in the same chat during a rolling 48-hour window.
This also limits negative reaction announcements to one per pair per window,
across all of the recipient's messages. Removing all of an actor's negative
reactions from a charged message refunds its charged vibe but does not reset
the window. Removing uncharged reactions gives no refund. The allowance is
checked when the update is processed. It does not
automatically charge reactions that remain active when the window expires.
Existing charges retain their timestamps when deploying a new window duration.
All active negative reactions still count toward message deletion, including
reactions that did not deduct vibe. Anonymous aggregate reaction counts have
no actor identity and retain their existing scoring and announcement behavior.

Automatic vibe notifications for thanks, reactions (including anonymous
aggregate counts), and profanity penalties are sent silently as
[ephemeral messages](https://core.telegram.org/bots/api#ephemeral-messages-and-commands).
Only the recipient and the bot can see them inside the group. They are not
queued for deletion. Telegram may discard them while the recipient is offline,
and clients may remove them over time or after restarting. Scores remain in D1.
Notification failures are logged without publishing a public fallback and do not
interrupt message deletion or low-vibe bans. `disable_notification` prevents
sound; it does not guarantee that the client shows no notification.
Command replies and link moderation warnings retain their existing visibility.
Welcome messages remain public and are deleted after 15 seconds.

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
Administrator status also allows the bot to send ephemeral vibe notifications
directly to any non-bot member without a callback or prior private conversation.

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

The negative reaction limit requires migration `0007_negative_reaction_limits.sql`
before deploying the updated Worker. It preserves scores and refunds for existing
active reactions. It seeds pair windows from the latest negative reaction ledger
delta. Legacy entries combine negative charges and positive reaction rollbacks,
so a recent positive rollback can also consume the initial window. Pause update
processing for the migration and deployment, and preserve pending updates. The
old Worker does not maintain the new refundable-charge state. After a rollback,
reconcile that state before deploying the updated Worker again.

The out-of-order refund fix additionally requires migration
`0008_negative_reaction_charge_origins.sql`. It moves existing refundable totals
into charge records and removes the old total column. Scores and pair-window
timestamps do not change. New charges record their reaction date and update ID.
A delayed removal can then refund an earlier charge without refunding a newer
charge or replacing the latest active reaction snapshot.

Legacy totals do not identify the individual reaction events that incurred them.
Migration `0008` uses each last stored snapshot as a conservative baseline.
Removals older than that baseline cannot refund the migrated total. Later
removals retain the existing refunds. The migration does not reconstruct missing
history or rescan Telegram messages.

Pause update processing and preserve pending updates while applying `0008` and
deploying its Worker. The previous Worker is incompatible with the migrated
schema. Prefer a forward fix. A rollback needs update processing paused and a
reviewed schema/data conversion that restores refundable totals from the charge
records before deploying the previous Worker. Do not redeploy the new Worker
after an old Worker has processed updates without reconciling charge origins.

## License

Copyright 2026 Dima Sukharev.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
