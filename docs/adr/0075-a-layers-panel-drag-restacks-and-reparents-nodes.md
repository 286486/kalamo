---
status: accepted
date: 2026-09-30
---

# A Layers panel drag restacks and reparents Nodes through one `reparent` Command

F-LAYER-01 asks for drag-to-restack and drag-to-reparent in the Layers panel. Since #54 an Agent moves Nodes with `kalamo_node_reparent` (ADR-0071), but ADR-0071 left the browser out: the panel had no drag and the socket no reparent Command (#190). Illustrator's Layers panel moves objects, Groups and Layers by dragging their rows. Kalamo follows Illustrator's semantics (REQUIREMENTS §2).

## The rule

- **One Command, one core edit.** The browser sends `{type: "reparent", moves}` over the Document socket (ADR-0010), with `moves` as `node_reparent` takes them. The Document Durable Object runs the same `reparentNodes` as the MCP tool, so the tree rules, keys and Clipping Path rules are ADR-0071's. A drop is one Transaction and one undo step. A Command naming a Node deleted meanwhile, whether moved, parent or anchor, is `NODE_GONE`, as for every Command.
- **Editors only.** A viewer's rows do not drag, and the Durable Object refuses a viewer's Command regardless (ADR-0047).
- **What a row carries.** Dragging a selected row carries the whole Selection; dragging any other row carries only its Node. A Layer is never in the Selection (ADR-0012), so a Layer's row carries that Layer. A dragged Node whose ancestor is dragged too moves with that ancestor, not by itself.
- **Where it lands.** The top and bottom quarters of a Layer or Group row are the gaps above and below it; its middle drops into it, on top. Below an expanded container means into it, on top, since the gap lies over its topmost child. A leaf row's top and bottom halves are the gaps above and below it. A gap lands at that position in the row's parent.
- **Several Nodes keep their order.** The dragged Nodes land together in the order the panel lists them, top first, whatever parents they came from. The topmost lands at the drop, and each next one directly below the one before it. The first move names an undragged sibling as its anchor (`after` the nearest one below the gap, else `before` the nearest one above it, else no position), so it never anchors on a Node that is itself moving.
- **Indicators.** An insertion line marks a gap and an outline marks a container. A refused drop shows no indicator and sends nothing: the browser cursor shows it cannot drop.
- **Refused drops.** The panel plans the drop with core's `reparentNodes` on a copy, so whatever core refuses (a Node into itself or its own descendant, a Layer into a Group, a non-Layer to the root) is refused in the panel too, with no second copy of the tree rules. The panel also refuses:
  - a target container that is locked, itself or through an ancestor;
  - a dragged Node whose container is locked, since leaving changes that container's contents as much as arriving does;
  - in Isolation Mode, a target outside the isolated Node (ADR-0057, ADR-0058).
- **Hidden and locked Nodes.** A hidden container takes a drop, as in Illustrator. A Node's own lock does not stop its row's drag: the lock protects its artwork on the canvas, and a move changes neither its geometry nor its content (ADR-0007). Illustrator restacks a locked Layer in its panel the same way.
- **No empty undo step.** A drop where no Node would change parent or key sends nothing, as Object > Arrange does (ADR-0074).
- **Clipping Paths** follow ADR-0071: dragged to another parent a Clipping Path loses `clipping` and its Clip Group becomes an ordinary Group; restacked in its own parent it stays the Clipping Path.

## Keyboard

The panel has no keyboard move, as Illustrator's has none. Keyboard restacking in a parent is Object > Arrange and its shortcuts (ADR-0074). Moving to another Layer from the keyboard is Cut, then Paste in Place with something in the target Layer selected, since new art goes to the Layer of the Selection (ADR-0017), as Illustrator pastes into the active Layer. The pasted Nodes are new Nodes with new ids, and there is no keyboard route into a Group.

## Considered Options

- **Pointer events and a hand-drawn drag ghost.** Rejected: HTML5 drag and drop gives the drag image, the no-drop cursor and dragging over a scrolled list for free, and a panel row is not a canvas gesture.
- **Refuse a drag of any locked or hidden Node**, as a canvas drag leaves them where they are (ADR-0012). Rejected: the panel is where a person finds and arranges such Nodes, and Illustrator's panel restacks a locked Layer.
- **Check the tree rules again in the browser.** Rejected: running core's `reparentNodes` on a copy is the same check, so the two cannot drift.
- **Delete a Group the drag empties**, as Illustrator does. Rejected for the same reason as in ADR-0071: one core edit, one rule.
- **Alt-drag to copy.** Out of scope: it needs a duplicate edit, which does not exist yet.

## Consequences

- `ClientMessage` gains `reparent`, and the Durable Object's Command table one entry. ADR-0071's note that the browser has no reparent Command, and ADR-0012's "no drag reordering yet", no longer hold.
- The Layers panel's rows are a list (`ul` and `li`), each named by its Node's name, so a test or a screen reader can find a row.
- The panel re-plans the drop on every `dragover`: a copy of the Document's Node map per event, fine at the Document sizes of REQUIREMENTS §7.1.
