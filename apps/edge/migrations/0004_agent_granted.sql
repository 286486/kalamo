-- MCP OAuth (ADR-0047): when the Agent Actor was last approved, so listing Connected Agents gives
-- a fresh grant a grace window for KV list lag. Older rows fall back to `created_at`.
ALTER TABLE actors ADD COLUMN granted_at TEXT;
