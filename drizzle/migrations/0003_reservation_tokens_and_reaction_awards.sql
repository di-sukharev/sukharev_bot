ALTER TABLE processed_updates
  ADD COLUMN reservation_token TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS reaction_awards (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  positive_reaction_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id, actor_user_id)
);

CREATE INDEX IF NOT EXISTS reaction_awards_recipient_idx
  ON reaction_awards (chat_id, recipient_user_id);
