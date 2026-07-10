CREATE TABLE IF NOT EXISTS reaction_award_reservations (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  reservation_token TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id, actor_user_id)
);

CREATE INDEX IF NOT EXISTS reaction_award_reservations_updated_idx
  ON reaction_award_reservations (updated_at);
