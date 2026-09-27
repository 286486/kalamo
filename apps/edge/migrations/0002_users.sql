-- Hosted identity (ADR-0047). A User signs in with GitHub; every User has one `user` Actor,
-- `user_<id>`. Agent Actors (`client_id`, `access`, `revoked_at`) arrive with MCP OAuth.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT
);
-- One row per browser session: the SHA-256 of its cookie token, never the token.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('user', 'agent')),
  client_id TEXT,
  name TEXT NOT NULL,
  access TEXT,
  created_at TEXT,
  revoked_at TEXT
);
