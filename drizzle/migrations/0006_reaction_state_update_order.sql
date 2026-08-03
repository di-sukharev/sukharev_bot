ALTER TABLE reaction_vibe_states ADD COLUMN last_update_id INTEGER;
ALTER TABLE reaction_vibe_states ADD COLUMN last_update_date INTEGER;

ALTER TABLE moderation_actions
  ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE moderation_actions ADD COLUMN reservation_token TEXT;
ALTER TABLE moderation_actions ADD COLUMN updated_at TEXT;
