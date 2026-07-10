ALTER TABLE processed_updates
  ADD COLUMN status TEXT NOT NULL DEFAULT 'processed';

ALTER TABLE processed_updates
  ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE processed_updates
SET updated_at = processed_at
WHERE updated_at = '';

CREATE INDEX IF NOT EXISTS processed_updates_status_updated_idx
  ON processed_updates (status, updated_at);
