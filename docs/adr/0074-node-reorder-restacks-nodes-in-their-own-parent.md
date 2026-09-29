---
status: accepted
date: 2026-09-30
---

# `node_reorder` and Object > Arrange restack Nodes in their own parent

REQUIREMENTS §6.4 lists `kalamo_node_reorder {docId, nodeIds[], op: front | forward | backward | back}`, and F-XFORM-06 asks for Illustrator's Object > Arrange with its shortcuts. Neither existed: Agents restacked with same-parent `node_reparent` (ADR-0071), and the browser could not restack at all (#191).

Illustrator's Help ("Stacking objects") says Bring to Front and Send to Back move an object "to the top or bottom position in its group or layer", and Bring Forward and Send Backward move it "by one object to the front or one object to the back of a stack". Kalamo follows Illustrator's semantics (REQUIREMENTS §2).

## The rule

- **One core edit, two entry points.** `reorderNodes(doc, nodeIds, op)` in core serves `kalamo_node_reorder {docId, nodeIds, op, partial?, intent?, txId?, ifRev?}` (1 to 1000 ids) and the browser's `reorder` Command. Object > Arrange has Illustrator's four entries and shortcuts: Bring to Front Shift+Ctrl+], Bring Forward Ctrl+], Send Backward Ctrl+[, Send to Back Shift+Ctrl+[. The Transaction summary is the menu label.
- **Own parent only.** Each Node is restacked among its siblings and never changes parent. Moving to another Layer or Group is `node_reparent`.
- **`front` and `back`** put the parent's selected Nodes on top of, or below, its other children, in the order they had among themselves. The order of `nodeIds` does not matter.
- **`forward` and `backward` step past one sibling**, whether or not it overlaps: Illustrator's "one object". This is not Inkscape's Raise, which steps past the next overlapping object.
- **Several Nodes in one parent keep their relative order.** Working from the leading edge back, each selected Node swaps with the unselected sibling just ahead of it. So a run of adjacent selected Nodes moves as a block, past one sibling. A run already at the top (for `forward`) or bottom (for `backward`) stays where it is, and a selected Node further back closes up to it.
- **Several parents.** Nodes in different parents are each restacked in their own parent by the same rule. A Node and its ancestor can both be named: each moves among its own siblings.
- **Keys.** The moves are same-parent `node_reparent` moves (`before`, `after` or `index`), applied in order. So a moved Node gets a fractional-index key between its new neighbours, a Node already in its slot keeps its key, and no other Node's key changes (ADR-0071).
- **Already at the edge is a no-op, not an error.** A Node already where `op` puts it is left out of `updatedIds`. If none moves, the receipt lists none. The call still commits, as `node_update` of an unchanged value and `node_reparent` to the same place do: `rev` +1 and an undo step that changes nothing. The browser sends no Command when nothing would move, so Ctrl+Z after an Arrange shortcut always undoes something visible.
- **Any Node.** MCP accepts any Node, Layers included: a top-level Layer is restacked among the top-level Layers, a Sublayer among its parent's children. The browser acts on the Selection that is not hidden or locked, as the other Object commands do.
- **Clipping Paths** keep `clipping` when restacked, since their position in the Clipping Mask does not matter (ADR-0021). The Clip Group draws the same.
- **One write.** One Transaction, one WriteReceipt, one undo step (ADR-0011). An unknown id is `NODE_NOT_FOUND` with `path` `nodeIds[i]`. With `partial`, it is skipped and listed in `failed`. The input schema is strict (ADR-0050). Locks do not refuse an MCP write (ADR-0027).

## Considered Options

- **Step past the next overlapping sibling**, as Inkscape's Raise and Lower do. Rejected: Illustrator steps past one object. An Agent can also predict one-sibling steps from `doc_outline` without computing overlaps.
- **Refuse a Node already at the edge with `INVALID_INPUT`.** Rejected: Illustrator runs the command without complaint, and a batch of Nodes where some are already on top would fail on the ones that need nothing.
- **Commit nothing when nothing moves** (no `rev`, no undo step). Rejected for MCP: every other write that changes nothing commits, and a receipt needs a Transaction. The browser avoids the empty step by not sending.
- **Accept only leaves and Groups, and leave Layers to `node_reparent`.** Rejected: restacking a Layer in its parent is well defined, and Illustrator's Layers panel restacks Layers too.
- **A second key rule for reorder.** Rejected: reusing `node_reparent`'s moves keeps one place that assigns keys.

## Consequences

- `node_update`'s `READ_ONLY` hint for `index` names `node_reorder` first, and `node_reparent` for an exact place. `node_update`'s description, the drawing conventions, REQUIREMENTS §6.4 and F-XFORM-06 mention it.
- `keysOf` names Shift+] and Shift+[ as the bracket keys, since the browser reports `}` and `{`.
