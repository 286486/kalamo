---
status: accepted
date: 2026-09-23
---

# A Transaction is an overlay of base and working Node copies, merged by top-level key at commit

An open Transaction keeps, for every Node it touched, the committed copy at first touch (`base`) and its own current copy (`working`; absent when deleted in the Transaction). Both live in the Document Durable Object's SQLite, so an eviction or restart does not lose them. Reads and writes carrying the `txId` see the committed Document with the working copies laid over it. Only the Actor that called `tx_begin` may use the `txId`; any other Actor gets `TX_NOT_FOUND`.

`tx_commit` applies, per Node, only the top-level keys whose working value differs from `base`, onto the Node as committed now. This is ADR-0004's per-property last-writer-wins: a person who changed a Node's `name` while an Agent's Transaction changed its `appearance` keeps the new name. A "property" is a top-level Node key, so `appearance` and `transform` merge as wholes.

The commit fails as a whole with `NODE_GONE`, and the Transaction stays open, when a Node whose `base` exists is no longer committed (unless the Transaction itself deleted it: both deletes agree), or when a Node created in the Transaction has a parent that was committed at the time and is gone now. The error's `nodeIds` lists the gone ids: the edited Node, or the parent. A Node the Transaction deletes takes its descendants as committed at commit time, so a child someone added meanwhile goes too (delete beats edit). Amended by ADR-0072: a Node the Transaction moved into a parent gone now is `NODE_GONE` too, and a merge that would break a tree rule or add a second Clipping Path fails with `TREE_CONFLICT`.

## Considered Options

- **Whole-Node overwrite at commit**: simpler, but it clobbers a person's concurrent edits to properties the Agent never touched, which contradicts ADR-0004.
- **Replay the calls at commit**: a replayed `node_transform` recomputes its pivot from bounds that may have moved, so the result can differ from what the Agent saw and checked with `render`.
- **Overlay in DO memory**: loses an Agent's uncommitted work whenever the Durable Object is evicted.

## Consequences

- A Node created in the Transaction takes its fractional `index` from the overlay's view, so a concurrent insert under the same parent can tie. Their relative order is then unspecified; it is not an error.
- `tx_begin` takes an optional `label` (the log row's summary) and has a fixed 5-minute idle timeout, extended by every call that carries the `txId`. `timeoutSec` is deferred.
- `node_get`, `node_query`, `doc_outline`, `render` and `export` accept `txId`.
