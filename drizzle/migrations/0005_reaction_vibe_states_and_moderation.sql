CREATE TABLE IF NOT EXISTS reaction_vibe_states (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  positive_reaction_count INTEGER NOT NULL,
  poop_reaction_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id, actor_id)
);

INSERT OR IGNORE INTO reaction_vibe_states (
  chat_id,
  message_id,
  actor_id,
  recipient_user_id,
  positive_reaction_count,
  poop_reaction_count,
  updated_at
)
SELECT
  chat_id,
  message_id,
  actor_user_id,
  recipient_user_id,
  positive_reaction_count,
  0,
  updated_at
FROM reaction_awards;

CREATE INDEX IF NOT EXISTS reaction_vibe_states_recipient_idx
  ON reaction_vibe_states (chat_id, recipient_user_id);

CREATE INDEX IF NOT EXISTS reaction_vibe_states_message_idx
  ON reaction_vibe_states (chat_id, message_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  target_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS moderation_actions_chat_action_idx
  ON moderation_actions (chat_id, action);
