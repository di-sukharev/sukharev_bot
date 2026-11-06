-- One row per subscription update in a monitored channel. Rows feed burst
-- detection and list the subscribers with the action that the bot took. The
-- profile flags stay NULL until the bot reads the subscriber's profile.
CREATE TABLE channel_joins (
  update_id INTEGER PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  is_premium INTEGER NOT NULL,
  language_code TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'checking', 'banned', 'ban_failed')),
  has_bio INTEGER,
  has_personal_chat INTEGER,
  has_emoji_status INTEGER,
  has_profile_audio INTEGER,
  has_photo INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX channel_joins_chat_joined_at_idx
  ON channel_joins (chat_id, joined_at);

-- The time of the last burst alert for each monitored channel.
CREATE TABLE channel_alerts (
  chat_id TEXT PRIMARY KEY NOT NULL,
  alerted_at INTEGER NOT NULL
);
