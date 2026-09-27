-- MCP OAuth (ADR-0047): an Agent Actor is one approved MCP client, by its client id and redirect
-- URI, so re-authorizing the same client keeps its Actor.
ALTER TABLE actors ADD COLUMN redirect_uri TEXT;
