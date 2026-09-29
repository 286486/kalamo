---
status: accepted
date: 2026-09-29
---

# A Layer can be a Clipping Mask, clipped by its one Clipping Path

Illustrator's Layers panel has a Make/Release Clipping Mask button. It makes the topmost object of the targeted Layer or sublayer the Clipping Path of everything else in that Layer, sublayers included. Inkscape writes the same thing as `clip-path` on a layer `<g>`, and its Object > Clip > Set with a layer selected writes one. ADR-0021 allows a Clipping Path only in a Group. So Kalamo cannot make a Layer Clipping Mask, and import drops a clipped layer's clip with `UNSUPPORTED_ATTRIBUTE` `clip-path` (#51). This ADR lets a Layer hold a Clipping Path. It amends ADR-0021 and ADR-0052, and applies ADR-0051 to Layers.

## What Illustrator does

- **Make.** The Layers panel button acts on the targeted Layer. The Layer's topmost object becomes its Clipping Path. It must be a vector object: a path, a compound path or a text. Like Object > Clipping Mask > Make, it sets the path to no Fill and no Stroke. No Clip Group is created. The Layer keeps its name and structure, and its sublayers stay sublayers. The Layers panel underlines the Layer's name and the Clipping Path's name.
- **What it clips.** Every other object in the Layer and in its sublayers draws only inside the Clipping Path. Artwork drawn or pasted into the Layer later is clipped too.
- **Selecting.** Objects in a clipped Layer are selected as themselves, since there is no Clip Group to select. Their own bounding boxes are unchanged.
- **Release.** The same button releases the mask. The path stays, with whatever paint it has.

Adobe's help pages refuse automated fetches. This record rests on Illustrator's documented behaviour ("the topmost object in the layer or group becomes the clipping path"; the Make/Release Clipping Mask button at the bottom of the Layers panel), on its scripting DOM (`PageItem.clipping`), and on common practice, as ADR-0052 does.

## The rule

- **The tree.** A Layer, like a Group, is a Clipping Mask when one of its children has `clipping: true`. That child is the Layer's Clipping Path. Every rule of ADR-0021, ADR-0051 and ADR-0052 applies unchanged. A Layer has at most one Clipping Path, which is a Live Shape, a Path or a text. It cannot be hidden (`INVALID_PATCH`). Its place among its siblings does not change what is drawn. `clipping` is read-only to `node_update` and `node_create`, and deleting the Clipping Path leaves an ordinary Layer. `doc_open` accepts `clipping` on a child of a Layer and still refuses a second one.
- **What it clips.** It clips every other child of the Layer and their descendants, sublayers and Clip Groups included. Nested clips intersect, as they already do for Groups inside Groups. A Node created in, pasted into, or moved into a clipped Layer is clipped, wherever it sits in the stacking order. Illustrator keeps its Clipping Path on top. Kalamo does not reorder anything, and ADR-0021 already makes position meaningless, so a new Node on top is clipped as well.
- **Drawing.** A Layer draws exactly as a Group does (ADR-0043, ADR-0044, ADR-0051): container paints below Contents, the Clipping Path's Fills, the other children, the Clipping Path's Strokes unclipped, container paints above Contents. A text Clipping Path masks through a layer (ADR-0052). A Layer's `opacity` and `blendMode` wrap all of it, as a Group's do.
- **Bounds.** A clipped Layer's `geometricBounds` and `visibleBounds` are its Clipping Path's, as for a Group (ADR-0021, ADR-0051). `doc_outline`, a `nodeIds` Render Scope that names the Layer, and anything that unions Layers follow. Children keep their own bounds, as in Illustrator.
- **Hit test.** A point outside the Clipping Path misses the clipped content (ADR-0021). The Selection tool picks the object below the Layer, as it does for any object in a Layer. So a painted Layer Clipping Path, hit on its Fill or Stroke, is picked itself. An unpainted one hits nothing.

## Make and Release

- **`kalamo_mask_make`** takes a second form: `{docId, layerId, kind?}`. It is the Layers panel button. The Layer's topmost child becomes its Clipping Path, its Appearance is emptied (and for a text, its Range Fills removed, ADR-0052), and nothing moves. The receipt lists that child in `updatedIds` and creates nothing. It is one Transaction, and undo reverses it. Each refusal is `INVALID_MASK` at `layerId`:
  - the id is not a Layer;
  - the Layer is already a Clipping Mask;
  - the Layer has no children;
  - its topmost child is a Group, a Layer or an Image, not a Live Shape, a Path or a text, with the hint to put one on top first;
  - its topmost child is hidden.

  A Layer whose only child is the new Clipping Path is accepted: it clips whatever is drawn into it later. The form with `clipNodeId` and `contentIds` is unchanged, and giving both `layerId` and `clipNodeId` is `INVALID_INPUT` (ADR-0050).
- **`kalamo_mask_release`** accepts a clipped Layer's id or its Clipping Path's id, as it already does for a Group. The Layer and the Path stay. No schema change.
- **Browser.** The Layers panel gains Illustrator's Make/Release Clipping Mask button at its foot. It acts on the Layer that Place and new art target: the nearest Layer holding the first selected Node, or the top Layer. It sends `mask_make {layerId}` when that Layer is not clipped, and `mask_release` with the Layer's id when it is. Object > Clipping Mask > Make (Ctrl+7) still makes a Group from the Selection. Release (Alt+Ctrl+7) also releases a Layer when the Selection holds its Clipping Path. A clipped Layer keeps its name, or `<Layer>` when it has none. Only a Group is auto-named `<Clip Group>`. As in Illustrator, the panel underlines the name of a Clipping Mask, Layer or Group, and of its Clipping Path.

## Place and paste

- **Place** turns a file's Layers into Groups (ADR-0017), so a clipped Layer arrives as a Clip Group with the same Clipping Path. No new rule.
- **Paste** never makes the target a Clipping Mask. When a Kalamo copy's listed Nodes land directly in the target parent (ADR-0030), any of them that is a Clipping Path arrives with `clipping` removed, as an ordinary Path with the Appearance it had. Otherwise pasting a Layer's Clipping Path into another Layer would clip that whole Layer, or give it a second Clipping Path. Copying objects out of a clipped Layer pastes them unclipped, since the clip belongs to the Layer, not to them.
- **Links.** A Group left holding only its Clipping Path after a dropped linked Image is removed (ADR-0042). A Layer is never removed this way.

## SVG

- **Export.** No new rule. A clipped Layer is a `<g inkscape:groupmode="layer">`, written as ADR-0021 and ADR-0051 write a Group. That is `clip-path` on the layer `<g>` with an inline `<clipPath>` at the Clipping Path's place. With Strokes it is instead the `<g kalamo:clipped>` wrapper inside the layer `<g>` plus the clip paint groups. Sublayers inside the wrapper keep `inkscape:groupmode="layer"`.
- **Import.** A layer `<g>` with a `clip-path` is read by ADR-0021's rules for a Group. One Live Shape, Path or text inside the `<clipPath>` becomes the Layer's Clipping Path, at its place when the `<clipPath>` is a child of the layer, or topmost in the Layer when it is in `<defs>`. The clip's coordinates are the layer's user space, so the layer's `transform` applies to the clip as it does to the children. A `<g kalamo:clipped>` inside a layer `<g>` is unwrapped as inside a Group, and its clip paint groups give the Clipping Path's Appearance (ADR-0051). A `<clipPath>` Kalamo cannot hold still imports the Layer unclipped with `UNSUPPORTED_ATTRIBUTE` `clip-path`, for the same reasons as for a Group.
- **Checked.** This was checked by hand with Inkscape 1.2.2 on hand-written files. Saving keeps a layer `<g clip-path>` with an inline `<clipPath>` child, its id, a translated layer and a sublayer. It also keeps a layer holding a `<g kalamo:clipped>` wrapper with a sublayer inside and a clip paint group, after an edit to that sublayer. Object > Clip > Set, run with a layer and an object above it selected (`select-by-id:L1,c1;object-set-clip`), writes `clip-path` on the layer `<g>` and the clip into `<defs>` under a new id. The clip's geometry is rewritten into the layer's user space, a translated layer included, and the object's old style is left on it. So the `<defs>` rule places it on top, and ADR-0051 ignores its paint.

`render` draws the SVG through resvg, so it follows this mapping. The canvas draws the same items from the same Nodes.

## Considered Options

- **Keep Layers unclipped** (ADR-0021). Inkscape files that clip a layer, common after PDF and AI imports, would open looking different from Inkscape, and a round trip would drop the clip. Illustrator users lose a Layers panel command.
- **Import a clipped layer as a Layer holding one Clip Group.** No model change, but an extra Group appears in the tree. Sublayers cannot sit in a Group (ADR-0005), so a clipped layer with sublayers still could not be held. Export would also no longer write the file's structure back.
- **A `clipped` flag on the Layer, with its topmost child as the mask**, as Illustrator stores it. ADR-0021 rejected a positional mask for Groups: `node_create` adds children on top, so every new Node would become the mask. The same holds for Layers.
- **`kalamo_mask_make {clipNodeId, layer: true}`**, naming any child as the clip. This is more general than Illustrator, which always takes the topmost object, and it adds a second way of saying the same thing. An Agent that wants another child as the clip reorders the Layer first.
- **Move the Clipping Path to the top when art is added above it**, as Illustrator keeps it there. That would add a write that nobody asked for to every create, paste and reparent, and ADR-0021 already makes position meaningless.

## Consequences

- ADR-0021's rule "A Layer has none" and its "the same goes for a clipped Layer" import case are replaced by this ADR. ADR-0052's "none in a Layer" is too.
- When this lands, CONTEXT.md's Clipping Mask entry gains "a Group, or a Layer", F-MASK-01 names the Layer Clipping Mask, and REQUIREMENTS §10.2 row 40 drops "图层剪切蒙版暂缓".
- A `.kalamo.json` or SVG file written before this change opens as before. A stored Document never held a Layer Clipping Path, so nothing needs migrating. An SVG file with a clipped layer that opened unclipped before now opens clipped, as Inkscape shows it.
- The render fixture's hash changes once, when the fixture gains a clipped Layer.
- `node_reparent` (#54) follows the paste rule: a Clipping Path moved out of its Clipping Mask loses `clipping`, and moving Nodes into a clipped Layer clips them.
- Illustrator's own SVG, which writes a clip as `<clipPath><use xlink:href>`, imported unclipped for Layers and Groups alike when this was written. ADR-0056 reads it as a Clipping Path.
