CREATE TABLE IF NOT EXISTS telegram_users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS telegram_users_username_idx
  ON telegram_users (username);

CREATE TABLE IF NOT EXISTS telegram_chats (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  author_user_id TEXT NOT NULL,
  sent_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS telegram_messages_author_idx
  ON telegram_messages (author_user_id);

CREATE TABLE IF NOT EXISTS vibe_ledger (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  delta INTEGER NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_message_id INTEGER,
  target_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS vibe_ledger_chat_recipient_idx
  ON vibe_ledger (chat_id, recipient_user_id);

CREATE INDEX IF NOT EXISTS vibe_ledger_chat_created_idx
  ON vibe_ledger (chat_id, created_at);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
