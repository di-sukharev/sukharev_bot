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
- awards and rolls back positive vibe for thanks replies and Telegram reactions;
- applies permanent negative vibe for identifiable negative reactions;
- deletes messages with 3 or more active 💩/👎 reactions combined;
- permanently bans users at −10 vibe or below and requests deletion of all their
  messages in the same chat via Telegram's `revoke_messages` option;
- provides `/chatid`, `/rules`, `/vibe`, and `/vibe_top` commands;
- records new subscribers of monitored channels, bans subscriber farm profiles,
  alerts the channel operator about a join burst, and gives the operator
  private commands for stats, checks, unbans, and pauses;
- processes community updates idempotently through D1 reservations.

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
across all of the recipient's messages. The deduction is permanent: removing,
readding, or switching negative reactions does not refund vibe or reset the
window. Denied negative reactions send no notification. Positive reaction
awards and rollbacks retain their existing behavior.
The allowance is checked when the update is processed. It does not
automatically charge reactions that remain active when the window expires.
Delayed negative additions still use this allowance even if a newer removal or
switch was processed first. They do not replace the latest active reaction state
or change positive reaction scoring.
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
- `LINK_ALLOWED_USERNAMES` — usernames allowed to bypass link moderation;
- `MONITORED_CHANNEL_IDS` — comma-separated channel IDs (`-100…`) watched by
  the channel join monitor. Updates from these channels never reach community
  features. The production preflight rejects other values and requires the
  `CHANNEL_JOIN_QUEUE` and `CHANNEL_PROFILE_QUEUE` bindings with consumers;
- `CHANNEL_OPERATOR_USER_ID` — Telegram user ID of the channel operator. The
  operator receives join burst alerts and runs the channel commands. The
  production preflight requires it when `MONITORED_CHANNEL_IDS` is set.

Webhook setup additionally reads:

- `TELEGRAM_WEBHOOK_URL` — public HTTPS URL ending in `/telegram/webhook`;
- `TELEGRAM_WEBHOOK_ALLOWED_HOST` — exact host allowed by the setup guard;
- `TELEGRAM_DROP_PENDING_UPDATES` — optional boolean for intentionally dropping
  pending Telegram updates.

Never commit `.dev.vars` or the live `wrangler.toml`.

## Cloudflare setup

Create one D1 database and the Queues, then copy the returned D1 ID and the
chosen resource names into `wrangler.toml`. The channel join monitor needs the
two channel queues:

```bash
bunx wrangler d1 create sukharev-community-bot
bunx wrangler queues create sukharev-community-bot-vibe-notification-deletes
bunx wrangler queues create sukharev-community-bot-channel-joins
bunx wrangler queues create sukharev-community-bot-channel-profiles
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

## Channel join monitor

The bot protects each channel in `MONITORED_CHANNEL_IDS` against subscriber
farms. Add the bot to the channel as an administrator with
`can_restrict_members`. Telegram sends `chat_member` updates only after the bot
becomes an administrator, so the monitor cannot see earlier subscribers.

The webhook only puts each new subscription into `CHANNEL_JOIN_QUEUE`, so a
join flood does not hold up the community chat on the shared single-connection
webhook. The join queue consumer stores the joins, bans, checks profiles, and
alerts. It handles one batch at a time and makes Telegram calls one by one, so
bans stay within the Telegram rate limit. On a rate limit of up to 60 seconds,
both channel consumers wait for the `retry_after` time of Telegram, repeat the
call, and continue the batch. The wait uses no delivery attempt. On a longer
rate limit, the affected message and the rest of the batch go back to the queue
with a delay of `retry_after`.

The ban rules come from the farm accounts of the flood on 2026-11-06. The bot
bans a new subscriber at once when one of these rules matches:

- the name contains a South Asian script (Indian scripts and Sinhala), the
  Arabic script, or Chinese characters;
- the username is 5 random letters, `_`, 5 random letters, and 3 digits
  (`lozmn_egfrb932`), or 10 random letters and 3 digits (`zktkfncxqg547`);
- the username is the first 5 letters of the last name and the first name, in
  either order, optionally joined by `_`, and 3 digits (`ArnolVicen453` for
  Vicenta Arnold);
- the username is the Latin first name, an optional `_`, the Latin last name,
  and 1–3 extra letters (`antoninaklimanovayp`, `antonina_klimanovayp`);
- the subscriber has Telegram Premium, Latin first and last names of at least
  3 letters each, and 3 digits at the end of the username.

Other Premium subscribers with 3 digits at the end of the username wait as
`checking` while the bot reads the profile with `getChat`. The bot bans them
when the profile shows a photo, but no bio, personal channel, custom emoji
status, or profile audio. In all rules, a username that ends with `123` does not
count as 3 farm digits. The rules live in
[`src/channel-join-rules.ts`](src/channel-join-rules.ts).

The bot never bans `OWNER_USER_IDS`, users that the operator exempted, or anyone
in a channel where the operator paused bans. These joins are stored as
`allowed`. A pause or an exemption also stops a ban that is still pending.

Every subscription is stored in `channel_joins` with its Premium flag, language
code, and outcome: `allowed`, `checking`, `banned`, `ban_failed`, or
`unbanned`. A due ban stays `ban_failed` until Telegram confirms it, also when
Telegram rejects it or the queue gives up. A confirmed ban stores `banned_at`,
the Worker time of the ban in Unix seconds. After a join is handled,
`CHANNEL_PROFILE_QUEUE` reads the profile of the subscriber and stores the profile flags (`has_bio`,
`has_personal_chat`, `has_emoji_status`, `has_profile_audio`, `has_photo`) for
later rule tuning. Profile lookups pause between calls and leave the Telegram
rate limit to bans. A rejected lookup leaves the flags `NULL`.

A burst is 50 or more joins within 2 seconds. A burst bans nobody. It sends a
private alert to the operator at most once per 5 minutes per channel.
The alert lists the subscribers of those 2 seconds that the bot recorded by the
moment of the alert, with the bot's action for each. When the list exceeds one
Telegram message, the alert shows its start and the number of other
subscribers. The window uses Telegram update timestamps, so a queue backlog
delays bans and alerts but does not change them.

Telegram lets a bot message only users who started a private chat with it. The
operator must send `/start` to the bot once. Telegram rejections of a
ban, a lookup, or an alert (400 or 403) are logged and do not stop the queue. A
rejected alert still starts the cooldown. Other errors retry the join after 30
seconds, up to 100 times, so a Telegram outage does not use up the retries.
Profile lookups retry after 60 seconds. A redelivered join keeps its first row
and continues from its stored outcome. A retried alert can arrive twice.

### Operator commands

The operator runs these commands in the private chat with the bot. The bot
ignores them from other users and in other chats. Each command applies to all
monitored channels.

- `/start` adds the commands to the operator's command menu and lists them.
- `/stats` counts the joins of the last 24 hours by outcome and shows the last
  alert and the pause state.
- `/recent` lists the last 20 joins.
- `/check <user ID or @username>` shows the stored name, the rule that matches
  the latest stored name and username, the latest joins with their profile
  flags, and the exemption.
- `/unban <user ID or @username>` exempts the user from bans and unbans the user
  at once. The bot finds a username only among the users that it stored.
- `/unban_hours <N>` puts the users that the bot banned in the last N hours, by
  `banned_at`, into `CHANNEL_JOIN_QUEUE`. The join consumer unbans them one by
  one and marks the joins `unbanned`. A bulk unban adds no exemptions, so the
  rules ban these users again when they join again.
- `/pause` and `/resume` stop and restart automatic bans. Alerts continue during
  a pause.

All unbans use `only_if_banned`, so an unban never removes a current member.
Exemptions live in `channel_ban_exemptions` and pauses in `channel_ban_pauses`.
No command removes an exemption. Delete its row in D1 if necessary.

### Join listing

List the subscribers of a monitored channel who joined after a given time. The
query takes and shows Moscow time (UTC+3), the same time as the alert:

```bash
bunx wrangler d1 execute DB --remote --command "SELECT datetime(j.joined_at, 'unixepoch', '+3 hours') AS joined_at_msk, j.user_id, u.display_name, u.username, j.is_premium, j.language_code, j.outcome, j.has_bio, j.has_personal_chat, j.has_emoji_status, j.has_profile_audio, j.has_photo FROM channel_joins j JOIN telegram_users u ON u.id = j.user_id WHERE j.chat_id = '<channel id>' AND j.joined_at >= unixepoch('2026-11-06 12:45:00', '-3 hours') ORDER BY j.joined_at"
```

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

The negative reaction limit requires migration `0007_negative_reaction_limits.sql`.
It seeds pair windows from the latest negative reaction ledger delta. Legacy
entries combine negative charges and positive reaction rollbacks, so a recent
positive rollback can also consume the initial window. Migration
`0008_negative_reaction_charge_origins.sql` introduced charge origins for refunds.

Permanent negative charges require migration `0009_permanent_negative_reactions.sql`
before deploying this Worker. It removes the obsolete refund metadata table.
Existing scores, active reaction snapshots, and pair-window timestamps stay
unchanged. The migration does not rescan messages or restore refunded charges.

Pause update processing and preserve pending Telegram updates while applying
`0009` and deploying its Worker. The previous Worker needs the removed table
and cannot run against this schema. Prefer a forward fix. A rollback requires
paused processing and a reviewed schema/data conversion before deploying the
previous Worker. Resume the webhook only after deploying a compatible Worker.

The channel join monitor requires migration `0010_channel_joins.sql` and the
two channel queues before deploying its Worker. The migration only adds two
tables and an index, so the previous Worker keeps working against it. The
webhook already registers `chat_member` updates and needs no change.

The operator commands require migration `0011_channel_operator.sql` before
deploying their Worker. The migration rebuilds `channel_joins` to allow the
`unbanned` outcome and to add `banned_at`, and keeps its rows. Bans before
`0011` and bans by the previous Worker have no `banned_at`, so `/unban_hours`
counts them by their join time. The migration also adds the exemption and
pause tables. The Worker reads the operator from `CHANNEL_OPERATOR_USER_ID`,
which replaces `CHANNEL_ALERT_USER_ID`.

The previous Worker keeps working against `0011`, but it ignores pauses and
exemptions and drops queued `channel_unban` jobs. Roll back with
`wrangler rollback`, which keeps the previous version's `CHANNEL_ALERT_USER_ID`,
instead of a redeploy of the previous commit.

## License

Copyright 2026 Dima Sukharev.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
