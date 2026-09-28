---
status: accepted
date: 2026-09-23
---

# Browsers subscribe over one WebSocket: the whole Document, then one full-Node message per committed Transaction

A browser opens `GET /api/docs/:docId/ws`; the Worker forwards the upgrade to the Document Durable Object, which accepts it with the WebSocket Hibernation API. Connecting is subscribing. The DO first sends `{type: "document", rev, name, artboards, nodes}`, then, after every committed Transaction, one `{type: "tx", rev, txId, actor, intent, created, updated, deletedIds}` carrying full copies of the created and updated Nodes. A browser that misses a `rev`, or loses its socket, reconnects and gets the whole Document again. The connected browser count that `doc_get_info` reports is the DO's accepted socket count, with no counter of its own; a browser that vanishes without closing stays counted until the runtime notices the dead connection.

The broadcast is sent after the SQLite transaction returns, and each send's failure is swallowed, so a dead socket can never roll back a write. Staged writes in an open Transaction are not broadcast; its `tx_commit` is. An unknown `docId` gets HTTP 404 before the upgrade.

There is no browser authentication in M0: the viewer is read-only and runs on local `wrangler dev`, and a browser cannot put a Bearer header on a WebSocket. Browser writes (#9) act as the fixed User Actor; OAuth arrives in M1. `/mcp` keeps its Bearer check (ADR-0006).

## Considered Options

- **Property patches instead of full Nodes**: smaller messages, but the browser would need core's merge rules and the DO would have to diff; a Node is small and the DO already holds the full copies it commits.
- **Server-Sent Events**: one-way, so browser writes in #9 would need a second channel.
- **Polling `doc_changes`**: it carries ids only, so every poll would be followed by reads, and updates would lag.

## Consequences

- Message size follows Node size; a `node_create` of 2000 Nodes is one large message.
- Delete beats edit (ADR-0004) reaches the browser as `deletedIds`, which include descendants.
- REQUIREMENTS §7.5's authenticated WebSocket upgrade is deferred to M1. ADR-0047 authenticates it by the session cookie and an `Origin` check in GitHub mode, has the Worker set the socket's Actor and Role, and admits only a caller with a Role on the Document.
