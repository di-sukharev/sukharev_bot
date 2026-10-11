CREATE TABLE negative_reaction_charges (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  update_date INTEGER NOT NULL,
  update_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id, actor_id, idempotency_key)
);

-- Legacy totals have no per-charge event history. Use the last stored snapshot
-- as a conservative baseline, so older removals cannot refund a newer charge.
INSERT INTO negative_reaction_charges (
  chat_id, message_id, actor_id, idempotency_key, amount, update_date, update_id
)
SELECT chat_id, message_id, actor_id, 'legacy', charged_negative_reaction_count,
  COALESCE(last_update_date, 0), COALESCE(last_update_id, 0)
FROM reaction_vibe_states
WHERE charged_negative_reaction_count > 0;

ALTER TABLE reaction_vibe_states DROP COLUMN charged_negative_reaction_count;
