---
status: accepted
date: 2026-09-24
---

# A Clipping Mask is a Group with one clipping child

Designers crop artwork with Clipping Masks (Illustrator's Object > Clipping Mask > Make / Release, F-MASK-01), and Inkscape writes one as `clip-path` on the clipped object, so the round trip (ADR-0017) needs them (#31). REQUIREMENTS F-DOC-03 listed a `clip_group` node type whose first child is the clip path.

Zibel has no `clip_group` type. A Live Shape or Path gains `clipping: true`, after Illustrator's `PathItem.clipping`; a `group` with such a child is a Clipping Mask, as Illustrator's `GroupItem.clipped` is derived from its contents. That child is the Clipping Path. It clips its siblings, and nothing paints it. Every container rule, walk and query that treats a Group today keeps working.

- **The tree.** A Group has at most one Clipping Path. A Layer has none: Illustrator's Layer clipping mask and Inkscape's clipped layer are out of scope. A text is not a Clipping Path yet: the browser draws text with `fillText`, which Canvas 2D cannot clip by, so text waits for Create Outlines (F-TEXT-06) or an offscreen clip. (ADR-0052 amends this: a text is a Clipping Path, clipping by its glyphs.) `doc_open` refuses a file that breaks these rules (ADR-0016).
- **Where it sits.** Its place among its siblings does not change what is drawn. Make keeps every member's stacking order; import puts it where the file had it, so a round trip does not reorder.
- **What it clips.** Everything below the Group is drawn only inside the Clipping Path's geometry, under its fill rule (ADR-0018), in document coordinates after its own `transform` (ADR-0007). Its Appearance, `opacity` and `blendMode` are kept but not drawn while it clips. (ADR-0051 amends this: its Fills draw behind the content and its Strokes in front, in its opacity and blend mode.) It cannot be hidden: `visible: false` on it is `INVALID_PATCH` with a hint to release the mask, because SVG draws nothing through a clip path whose content is hidden, while Illustrator shows the content unclipped, and one file cannot hold both. Deleting it leaves an ordinary Group.
- **Bounds.** A Clipping Mask's `geometricBounds` and `visibleBounds` are its Clipping Path's geometric bounds, as Illustrator reports a clip group's; the WriteReceipt, `doc_outline`, Render Overlays and a `nodeIds` Render Scope follow.
- **Tools.** `zibel_mask_make {docId, clipNodeId, contentIds[], kind?}` and `zibel_mask_release {docId, nodeIds[]}`, as REQUIREMENTS §6.4 names them; `kind` is `"clip"`, its only value until Opacity Masks (F-MASK-02). Make needs the Clipping Path and every content Node to share one parent and none to contain another. It creates a Group there, at the topmost member's place, moves them in, sets `clipping` and empties the Clipping Path's Appearance, as Illustrator does. Release takes the Group's id or its Clipping Path's, as Illustrator releases from either, clears `clipping` and leaves the Group and the now unpainted Path. A refusal is `INVALID_MASK`. `clipping` is read-only to `node_update` and `node_create`, so these two tools are the only way to write it. Both are one Transaction, and undo reverses them like any other.
- **SVG.** Export writes the Group as `<g clip-path="url(#clip-z-<id>)">` with an inline `<clipPath clipPathUnits="userSpaceOnUse">` at the Clipping Path's place among the children, holding it as its own element and id, with `clip-rule`, which SVG reads there in place of `fill-rule`. A repainted Clipping Path with several Fills or Strokes writes only its first of each, since a `<clipPath>` holds no `<g zibel:stack>`. (ADR-0051 replaces this with clip paint groups.) Inkscape 1.2 keeps an inline `<clipPath>` where it is and keeps the ids inside it, so Replace maps the Clipping Path back. Import reads a `clip-path` on a `<g>` as that Group's Clipping Path. On a leaf, as Inkscape's Object > Clip > Set writes it (the clip in `<defs>`, a new id, its transform baked in), import makes a Group of the leaf's Nodes with the Clipping Path on top. The clip's coordinates are the referencing element's user space. A `<clipPath>` Zibel cannot hold imports unclipped with `UNSUPPORTED_ATTRIBUTE` `clip-path`: a missing reference, `objectBoundingBox` units, a `clip-path` on the `<clipPath>` itself, or anything but one Live Shape or Path inside (a text, a Group, a `<use>`, several children). (ADR-0052 amends this: one `<text>` imports as a text Clipping Path.) The same goes for a clipped Layer.
- **Canvas.** The browser clips a Group's children with `clip()` over the Clipping Path's outline, and a click outside it misses the clipped content, as in Illustrator. The Layers panel names the Group `<Clip Group>` and the Path `<Clipping Path>`, Illustrator's auto-names.

## Considered Options

- **A `clip_group` type whose first child clips** (REQUIREMENTS F-DOC-03). Every container check (23 in the code) would gain a third type. Position would carry meaning: deleting the first child would turn the next one into the mask, and a child added at the bottom would take over.
- **A `clipped` flag on the Group with the topmost child as the mask** (`GroupItem.clipped` alone). The same position problem at the other end: `node_create` adds children on top, so every new child would become the mask.
- **Several Clipping Paths, clipped by their union**, as an SVG `<clipPath>` with several children does. Canvas 2D intersects successive clips and cannot union them without path operations.
- **Drawing a painted Clipping Path**, Fill behind the content and Stroke in front, as Illustrator does. SVG and Inkscape have no such object; export would need a second element that import must pair back up. Left for its own issue.

## Consequences

- REQUIREMENTS F-DOC-03 drops the `clip_group` row; F-MASK-01's text Clipping Path and isolation mode wait. ADR-0017's `UNSUPPORTED_ATTRIBUTE` list keeps `clip-path` only for the cases above.
- Make and Release move Nodes to a new parent, the first core edit to do so; `node_reparent` can reuse the move.
- A Node stored before this change has no `clipping`, and every reader takes a missing one as false.
