ALTER TABLE reaction_vibe_states
  ADD COLUMN charged_negative_reaction_count INTEGER NOT NULL DEFAULT 0;

-- Preserve refunds for negative reactions charged before this migration.
UPDATE reaction_vibe_states
SET charged_negative_reaction_count = poop_reaction_count
WHERE actor_id <> '__reaction_count__'
  AND actor_id <> recipient_user_id
  AND recipient_user_id IN (SELECT id FROM telegram_users WHERE is_bot = 0);

CREATE TABLE negative_reaction_limits (
  chat_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  charged_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  PRIMARY KEY (chat_id, actor_id, recipient_user_id)
);

-- The legacy ledger merges positive rollbacks and negative charges. Use the
-- latest negative delta conservatively so rollout cannot reset an abuse limit.
INSERT INTO negative_reaction_limits (
  chat_id, actor_id, recipient_user_id, charged_at, idempotency_key
)
SELECT chat_id, actor_user_id, recipient_user_id, MAX(created_at), 'legacy'
FROM vibe_ledger
WHERE source = 'message_reaction' AND actor_user_id IS NOT NULL AND delta < 0
GROUP BY chat_id, actor_user_id, recipient_user_id;
