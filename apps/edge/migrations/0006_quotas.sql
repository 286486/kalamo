-- Beta quotas (ADR-0048): the image bytes each Document stores, which its Durable Object writes
-- back after a change, and each User's render and export calls per UTC day.
ALTER TABLE documents ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
CREATE TABLE usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('render', 'export')),
  n INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, kind)
);
