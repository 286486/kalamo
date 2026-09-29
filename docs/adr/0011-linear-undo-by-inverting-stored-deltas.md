---
status: accepted
date: 2026-09-23
---

# Undo and redo invert the stored delta of a committed Transaction, per top-level key, on one linear stack

Every committed Transaction stores its delta in the Document Durable Object's SQLite: one row per Node it changed, with the Node's copy before (none when it created the Node) and after (none when it deleted the Node). A delete stores every descendant it took; `revert` recreates parents before children whatever the row order. The Transaction that creates the Document stores none and is never undone.

The Document has one undo stack and one redo stack of `rev`s, whoever committed them (F-HIST-01). A committed Transaction goes on the undo stack and clears the redo stack. Undo pops the top `rev`, commits its inverse as a new Transaction attributed to the Actor who undid, and pushes that new `rev` onto the redo stack. Redo pops the redo stack, commits the inverse of that undo, and pushes the new `rev` onto the undo stack. So both are "invert the delta of the `rev` you pop", undo and redo are ordinary Transactions that increment `rev` and appear in `doc_changes` and the `tx` broadcast, and what is inverted is always what was actually applied, skips included. The undo stack keeps the latest 200 `rev`s; older ones drop off with their delta rows. (ADR-0017 kept deltas for every rev for 30 days so Replace could rebuild a file's base; ADR-0030 removed Replace and restored this rule.)

The inverse is applied to the Document as committed now, per Node:

- **Updated**: every top-level key whose value differs between before and after is set back to its before value (ADR-0008's per-key rule, so a later change to another key survives).
- **Created**: the Node and everything now beneath it are deleted (delete beats edit).
- **Deleted**: the Node is recreated from its before copy, keeping its id and fractional `index`, so it returns to its place in the stacking order.

A Node the inverse would update, or recreate under a parent, that is no longer in the Document is skipped (delete beats edit, ADR-0004). Skipped ids are listed in the Transaction's summary, which `doc_changes` shows, and in the `tx` broadcast as `skippedIds`. An undo whose every Node is skipped still commits, so the stacks keep moving.

In M0 only the browser undoes: `{type: "undo"}` and `{type: "redo"}` are new commands (ADR-0010), and the DO commits them as the Actor `user`. With an empty stack the command is rejected with `NOTHING_TO_UNDO` or `NOTHING_TO_REDO`. An open Transaction is not on the stack until `tx_commit`, and undo does not touch its overlay; its commit merges onto the undone state by ADR-0008.

## Considered Options

- **Per-Actor undo stacks**: the right model with several people editing (F-COLLAB-07), but it needs rebasing an Actor's older edits across other Actors' later ones. Deferred with the `history_*` tools, as #1 decided.
- **Undo as removal from the log (moving `rev` back)**: breaks ADR-0009's gapless `rev` stream for browsers and `ifRev` for Agents.
- **Whole-Node restore instead of per key**: simpler, but it would clobber a concurrent edit to a key the undone Transaction never touched.
- **The delta as one JSON column on `tx_log`**: a 2000-Node create would approach Durable Object SQLite's 2 MB row limit, and #1 keeps Nodes as rows, not blobs.

## Consequences

- Deltas for up to 200 Transactions are stored per Document, each as large as the Nodes it touched.
- Transactions committed before this ADR have no delta and are not on the stack.
- With one linear stack the skip rule cannot fire yet: a delete is always above the edits it would invalidate, so undo pops it first and recreates the Node, and any commit between an undo and its redo clears the redo. It becomes reachable with per-Actor undo. Until then it guards `revert` against `NODE_GONE` and is tested at the core seam. Amended by ADR-0072: undo and redo also skip a row that would break a tree rule or add a second Clipping Path, and rekey a Node whose key a sibling took. Amended by ADR-0073: they also skip the last row that would leave no top-level Layer.
