-- Document ownership (ADR-0047): one owner per Document, by construction a column, never a
-- `members` row. Documents made before hosting belong to dev mode's local User.
ALTER TABLE documents ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX documents_owner ON documents (owner_id);
CREATE TABLE members (
  doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (doc_id, user_id)
);
CREATE INDEX members_user ON members (user_id);
