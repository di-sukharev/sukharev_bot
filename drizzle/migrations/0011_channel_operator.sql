-- The channel operator can unban subscribers. SQLite cannot change a CHECK
-- constraint, so the table is rebuilt with the unbanned outcome and the ban time.
-- banned_at is the Worker time of the confirmed ban in Unix seconds. It stays
-- set after an unban. It is NULL for bans before this migration and for bans
-- by the previous Worker.
CREATE TABLE channel_joins_next (
  update_id INTEGER PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  is_premium INTEGER NOT NULL,
  language_code TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'checking', 'banned', 'ban_failed', 'unbanned')),
  banned_at INTEGER,
  has_bio INTEGER,
  has_personal_chat INTEGER,
  has_emoji_status INTEGER,
  has_profile_audio INTEGER,
  has_photo INTEGER,
  created_at TEXT NOT NULL
);

INSERT INTO channel_joins_next (
  update_id, chat_id, user_id, joined_at, is_premium, language_code, outcome,
  has_bio, has_personal_chat, has_emoji_status, has_profile_audio, has_photo, created_at
)
SELECT
  update_id, chat_id, user_id, joined_at, is_premium, language_code, outcome,
  has_bio, has_personal_chat, has_emoji_status, has_profile_audio, has_photo, created_at
FROM channel_joins;

DROP TABLE channel_joins;

ALTER TABLE channel_joins_next RENAME TO channel_joins;

CREATE INDEX channel_joins_chat_joined_at_idx
  ON channel_joins (chat_id, joined_at);

-- Unbans and the subscriber check look up the joins of one user.
CREATE INDEX channel_joins_user_idx
  ON channel_joins (user_id);

-- A row pauses automatic bans in its channel. Alerts continue.
CREATE TABLE channel_ban_pauses (
  chat_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

-- Users that the operator unbanned one by one. Monitored channels never ban them.
CREATE TABLE channel_ban_exemptions (
  user_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);
