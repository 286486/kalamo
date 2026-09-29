---
status: accepted
date: 2026-09-23
---

# The Layers panel lists the tree top of the stack first, toggles through an `update` command, and selects the exact Node a row names

The browser's Layers panel (F-LAYER-01, F-LAYER-03) is drawn from the Document the browser already holds, so an Agent's change shows as soon as its `tx` arrives. It follows Illustrator's Layers panel:

- **Order.** Siblings are listed topmost first, the reverse of draw order. Layers, Groups and leaves nest by `parentId`. Layers start expanded and Groups collapsed; expanding and collapsing is UI state, never sent.
- **Names.** A row shows the Node's `name`, and its `tags` beside it. A Node whose `name` is empty shows its auto-name, `<Rectangle>`, `<Ellipse>`, `<Line>`, `<Polygon>`, `<Star>`, `<Path>`, `<Group>` or `<Layer>`. The auto-name is display only and never stored, so an Agent that reads the Node still sees `name: ""`. A Text Node will be named by its content once Text Nodes exist.
- **Toggles.** The eye and the lock of a row send `{type: "update", nodeId, patch}` (ADR-0010), where `patch` holds only `visible` or `locked`. The DO commits it with `node_update`'s core edit as one Transaction of `user`, or rejects it with `NODE_GONE` like any command naming a deleted Node. A Node under a hidden or locked ancestor is hidden or locked too, as in Illustrator, though its own flag is unchanged. The row of every Node that is hidden or locked, itself or through an ancestor, is dimmed.
- **Selecting.** Clicking a row selects the Node it names, even inside a Group, as Illustrator's target circle does; Shift+click adds or removes it. Clicking a Layer's row selects the selectable objects in it, as Alt+clicking a Layer does, since a Layer itself is never part of the Selection (ADR-0010). A row is highlighted while its Node is selected.
- **Hidden and locked Nodes.** The canvas never hits or marquees a hidden or locked Node (ADR-0010). A row can still select one, so the person can find it, but a drag or Delete leaves it where it is and acts on the rest of the Selection: a gesture acts only on what the canvas could have selected.

## Considered Options

- **A general `update` command taking any `node_update` patch**: renaming and Appearance edits will want it, but the panel only needs two flags, and the browser is untrusted (ADR-0010). The command's patch widens when a gesture needs more.
- **Storing the auto-name as the Node's `name`**: an Agent would read `<Rectangle>` back as if someone had named it, and it would go stale when a Live Shape is converted to a Path.
- **A row click selecting the object the Selection tool would (the outermost Group)**: consistent with the canvas, but then nothing inside a Group could be reached before the Group Selection tool exists.
- **Refusing to select a hidden or locked Node**: Illustrator's behaviour, but the issue asks that a row still select a locked one; leaving it out of drags and deletes keeps the lock meaningful.

## Consequences

- The Selection may hold a Node inside a Group or a locked Node, so code that acts on the Selection filters it to the editable Nodes first.
- No thumbnails, Layer colours, drag reordering, search or filters yet (the rest of F-LAYER-01). Amended by ADR-0075: rows drag to restack and reparent.
