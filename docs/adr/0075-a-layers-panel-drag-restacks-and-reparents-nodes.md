---
status: accepted
date: 2026-09-30
---

# A Layers panel drag restacks and reparents Nodes through one `reparent` Command

F-LAYER-01 asks for drag-to-restack and drag-to-reparent in the Layers panel. Since #54 an Agent moves Nodes with `kalamo_node_reparent` (ADR-0071), but ADR-0071 left the browser out: the panel had no drag and the socket no reparent Command (#190). Illustrator's Layers panel moves objects, Groups and Layers by dragging their rows. Kalamo follows Illustrator's semantics (REQUIREMENTS §2).

## The rule

- **One Command, one core edit.** The browser sends `{type: "reparent", moves}` over the Document socket (ADR-0010), with `moves` as `node_reparent` takes them. The Document Durable Object runs the same `reparentNodes` as the MCP tool, so the tree rules, keys and Clipping Path rules are ADR-0071's. A drop is one Transaction and one undo step. A Command naming a Node deleted meanwhile, whether moved, parent or anchor, is `NODE_GONE`, as for every Command.
- **Editors only.** A viewer's rows do not drag, and the Durable Object refuses a viewer's Command regardless (ADR-0047).
- **What a row carries.** Dragging a selected row carries the whole Selection; dragging any other row carries only its Node. A Layer is never in the Selection (ADR-0012), so a Layer's row carries that Layer. A dragged Node whose ancestor is dragged too moves with that ancestor, not by itself. A dragged Node in a locked container stays where it is and the rest move, as code acting on the Selection leaves out what is locked (ADR-0012); a row in a locked container does not drag at all. Unlike ADR-0012's editable filter, a Node's own lock or hiding, or a hidden container, does not leave it out (see below).
- **Where it lands.** The top and bottom quarters of a Layer or Group row are the gaps above and below it; its middle drops into it, on top. Below an expanded container means into it, on top, since the gap lies over its topmost child. A leaf row's top and bottom halves are the gaps above and below it. A gap lands at that position in the row's parent.
- **The gap below an expanded container.** Below the last row of an expanded container's contents lies the gap below that row and also the gap below the container, and below each ancestor whose contents end there. The pointer's indent picks which, as Illustrator's insertion line follows the indent: at or right of the row's indent, below the row; further left, below the ancestor at that depth, down to the depth of the next row. So every position is reachable with the containers expanded, including below an expanded container that is its parent's bottom child. The insertion line starts at the indent of the depth it drops at.
- **Several Nodes keep their order.** The dragged Nodes land together in the order the panel lists them, top first, whatever parents they came from. The topmost lands at the drop, and each next one directly below the one before it. The first move names an undragged sibling as its anchor (`after` the nearest one below the gap, else `before` the nearest one above it, else no position), so it never anchors on a Node that is itself moving.
- **Indicators.** An insertion line marks a gap and an outline marks a container. A refused drop shows no indicator and sends nothing: the browser cursor shows it cannot drop.
- **Refused drops.** The panel plans the drop with core's `reparentNodes` on a copy, so whatever core refuses (a Node into itself or its own descendant, a Layer into a Group, a non-Layer to the root) is refused in the panel too, with no second copy of the tree rules. The panel also refuses:
  - a target container that is locked, itself or through an ancestor;
  - a drag whose every Node is in a locked container, since leaving changes that container's contents as much as arriving does. This is Kalamo's rule, from ADR-0027's canvas locks binding people: no Illustrator source says whether its panel lets a Node leave a locked Layer;
  - in Isolation Mode, a target outside the isolated Node (ADR-0057, ADR-0058).
- **Hidden and locked Nodes.** A hidden container takes a drop, without asking. Illustrator, dragging on the canvas or pasting into a locked or hidden Layer, first asks to unlock and show it; the panel drop needs no such question, since the Node's row stays in view in the panel, dimmed, and one Undo takes it back. A Node's own lock or hiding does not stop its row's drag: the lock protects its artwork on the canvas, and a move changes neither its geometry nor its content (ADR-0007). Illustrator's panel moves a locked sub-Layer whose parent is unlocked the same way.
- **No empty undo step.** A drop where no Node would change parent or key sends nothing, as Object > Arrange does (ADR-0074).
- **Clipping Paths** follow ADR-0071: dragged to another parent a Clipping Path loses `clipping` and its Clip Group becomes an ordinary Group; restacked in its own parent it stays the Clipping Path.

## Alt-drag copies

Amended by #194, on ADR-0076's `duplicate` edit. Illustrator's Layers panel duplicates a row dragged with Alt held: released on a Layer or Group, the copy goes to its top; released between rows, to that position. Alt may be pressed after the drag starts.

- **Alt at release decides.** A drop whose Alt key is down when the button is released sends one `{type: "duplicate", input}` Command instead of `reparent`, with `targetParentId` and a position. Pressing Alt mid-drag copies, and releasing it before the button moves, as on the canvas (ADR-0076). One Transaction, one undo step.
- **Same target, same set.** The copies land where a plain drop would put the originals: the top of a container row, or the gap between rows, at the indent-chosen depth. The copied Nodes are those a plain drag would move, so a Node in a locked container is left out, and they land as one block in the originals' panel order. With the originals still in place, any sibling anchors the block (`after` the sibling directly below the gap, else `before` the one directly above it, else on top).
- **Same refusals.** A copy is refused wherever a move is, with no indicator and nothing sent: this includes a drop into the dragged Node's own descendant. The originals stay put, so such a copy could work, but Illustrator documents no such drop, and core refuses a target inside a copied Node (ADR-0076).
- **A copy always lands.** Unlike a move, a copy dropped where the originals already are still sends: in the gap directly above its own row, for example, the copy lands directly above the original.
- **Indicator.** While Alt is down, the drop effect is `copy`, and the browser's cursor shows a plus sign.
- **Selection and names.** The copies become the Selection, as ADR-0076's canvas copies do. A copied Layer is selected as its row's click selects it (ADR-0076, #195): its row highlighted, and its objects unless it is hidden or locked, itself or through an ancestor, when none are. The copies keep their names. Only Duplicate adds " copy" (#195).
- **Clicks and viewers.** Alt-click on a row still selects, and on a Layer's row still selects its contents (ADR-0012). A viewer's rows drag neither with Alt nor without it, and neither does text selected in them.

## Keyboard

The panel has no keyboard move, as Illustrator's has none. Keyboard restacking in a parent is Object > Arrange and its shortcuts (ADR-0074). Moving to another Layer from the keyboard is Cut, then Paste in Place with something in the target Layer selected, since new art goes to the Layer of the Selection (ADR-0017), as Illustrator pastes into the active Layer. The pasted Nodes are new Nodes with new ids, and there is no keyboard route into a Group.

## Considered Options

- **Pointer events and a hand-drawn drag ghost.** Rejected: HTML5 drag and drop gives the drag image, the no-drop cursor and dragging over a scrolled list for free, and a panel row is not a canvas gesture.
- **Refuse a drag of any locked or hidden Node**, as a canvas drag leaves them where they are (ADR-0012). Rejected: the panel is where a person finds and arranges such Nodes, and Illustrator's panel moves a locked sub-Layer.
- **Refuse the whole drop when one dragged Node is in a locked container.** Rejected: code acting on the Selection leaves out what it cannot change and acts on the rest (ADR-0012).
- **A drop zone below the list, or dragging below an expanded container meaning below it.** Rejected: the first reaches only the bottom of the top level, and the second puts the line over the container's topmost child while the Nodes land below its whole contents.
- **Check the tree rules again in the browser.** Rejected: running core's `reparentNodes` on a copy is the same check, so the two cannot drift.
- **Delete a Group the drag empties**, as Illustrator does. Rejected for the same reason as in ADR-0071: one core edit, one rule.
- **Alt-drag to copy.** Out of scope at first, as it needed a duplicate edit. Added by #194 on ADR-0076's edit (see "Alt-drag copies").
- **Let an Alt-drag copy into the dragged Node's own descendant.** Rejected: Illustrator documents no such drop, and core's duplicate refuses a target inside a copied Node.
- **Send nothing for a copy that changes no position**, as for a move. Rejected: a copy adds a Node wherever it lands, so it is never an empty step.

## Consequences

- The panel's Alt-drop sends ADR-0076's `duplicate` Command and needs no new message type.
- `ClientMessage` gains `reparent`, and the Durable Object's Command table one entry. ADR-0071's note that the browser has no reparent Command, and ADR-0012's "no drag reordering yet", no longer hold.
- The Layers panel's rows are a list (`ul` and `li`), each named by its Node's name, so a test or a screen reader can find a row.
- The panel re-plans the drop on every `dragover`: a copy of the Document's Node map per event, fine at the Document sizes of REQUIREMENTS §7.1.
