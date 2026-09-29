---
status: accepted
date: 2026-09-30
---

# `node_reparent` moves Nodes to another parent, or restacks them in their own

An Agent could not move a Node to another Layer or Group. `node_update` refuses `parentId` and `index`, and `mask_make` refuses content in another parent. REQUIREMENTS §6.4 names `node_reparent {docId, moves[]: {nodeId, parentId, index | before | after}}` (#54). Illustrator does this by dragging in the Layers panel, or with Cut and Paste in Front. Containers carry no transform (ADR-0007), so a move never changes geometry.

## The rule

- **One move per item.** `kalamo_node_reparent {docId, moves: [{nodeId, parentId, index?, before?, after?}], partial?, intent?, txId?, ifRev?}` takes 1 to 1000 moves. `parentId` is a Layer or Group id, or `null` to make a Layer top-level. The Node's descendants move with it untouched.
- **Position.** At most one of `index`, `before` and `after`; more is `INVALID_INPUT`. `index` is a 0-based position among the parent's other children, bottom first, in the order `doc_outline` lists them: 0 is the bottom and their count is the top. A larger value is `INVALID_INPUT`. `before: id` lands the Node directly below that sibling, and `after: id` directly above it. Each must name a child of `parentId` other than the Node itself, or it is `INVALID_INPUT`. With no position the Node goes on top, as `node_create` puts it. The same `parentId` with a new position restacks the Node, which is how an Agent reorders until `node_reorder` exists (#191).
- **Keys.** The moved Node gets a fractional-index key between its new neighbours. It keeps its key when that key already falls in the slot, as `mask_make` keeps keys. No other Node's key changes.
- **Refusals.** An unknown `nodeId`, `parentId`, `before` or `after` is `NODE_NOT_FOUND`. The tree rules (ADR-0005) are `INVALID_PARENT`: a Node into itself or its own descendant, a parent that is not a Layer or Group, a Layer into a Group, a non-Layer to the root, an Artboard id. Every refusal has `path` `moves[i].<field>` and a hint.
- **In order, one write.** Moves apply in order, each to the Document the moves before it left, and all are validated before anything is stored, as `node_update` stages its patches. The call is one Transaction, one WriteReceipt and one undo step (ADR-0011), summarised `Reparent N Nodes`. `updatedIds` lists each moved Node once, where it first appeared, with its final value. `bounds` is the union of the moved Nodes' bounds.
- **`partial` per move.** Without `partial`, one bad move refuses the call and nothing changes. With `partial`, a bad move is skipped and listed in `failed` with `index` = its position, and the later moves see the Document without it. If every move fails, the call fails with the first error, as for every other `partial` write.
- **Clipping Paths** follow ADR-0053's paste rule, as that ADR names for `node_reparent`:
  - A Clipping Path moved to another parent loses `clipping` and keeps whatever Appearance it has. So no Group or Layer ever holds two Clipping Paths.
  - A Clipping Path restacked in its own parent keeps `clipping`, since its position does not matter (ADR-0021).
  - A whole Clip Group or clipped Layer moves with its Clipping Path.
  - A Node moved into a Clip Group or a clipped Layer is clipped wherever it lands. Nothing is reordered.
- **Emptied containers stay.** A Group left empty, or a Clip Group left holding only its Clipping Path, is not deleted. Illustrator deletes an empty Group, but a named, empty Group is the skeleton an Agent builds first (the drawing conventions), and deleting it would be a write nobody asked for.
- **No lock check.** Locks bind the canvas, not MCP writes (ADR-0027). A locked Node, or a locked source or target parent, does not refuse a move.
- **Stateless.** One request per call, and `txId` stages the moves into an open Transaction like any write. MCP stays stateless Streamable HTTP (ADR-0006).

## Considered Options

- **`index` counted among all the parent's children, the Node included.** Rejected: restacking in place would then need the Node's own slot subtracted, and the same `index` would mean different places for a move in and a move within.
- **`before` meaning "earlier in the list", that is, above in z-order.** Rejected: `doc_outline` lists bottom first, so "before" in that list is below, and the `index` direction agrees.
- **Keep `clipping` on a Clipping Path moved to another parent**, refusing the move when the target already has one. Rejected: a move would fail on a property of the target the Agent did not name, and it would differ from paste (ADR-0053).
- **Delete Groups a move empties**, as Illustrator does. Rejected above.
- **Check locks**, as the canvas does. Rejected: no MCP write checks them (ADR-0027).

## Consequences

- `node_update`'s `READ_ONLY` hints for `parentId` and `index` point at `node_reparent`, and `index` says `node_reorder` is not available yet. `mask_make`'s refusal of content in another parent says to move it next to the clip Node first.
- ADR-0021's note that `node_reparent` can reuse Make's move does not apply: Make keeps keys because its Group is new and empty, while a move into a parent with children needs a new key.
- A committed Transaction's undo, and the commit of a staged one, merge per top-level key (ADR-0011) and do not re-check the tree rules against edits made since. Concurrent moves can then leave a cycle, a Layer in a Group or two Clipping Paths in one container. Re-checking them there is #189. Amended by ADR-0072: a commit that would do so fails with `TREE_CONFLICT`, an undo or redo skips the row, and a duplicate sibling key is rekeyed.
- The browser has no reparent Command yet: dragging in the Layers panel (F-LAYER-01) is #190.
