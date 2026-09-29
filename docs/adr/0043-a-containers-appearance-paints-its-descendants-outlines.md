---
status: accepted
date: 2026-09-27
---

# A container's Appearance paints its descendants' outlines

CONTEXT.md and F-DOC-04 say a Layer or Group can carry an Appearance, but only leaves took one, and `node_create` dropped a Group's `appearance` without a word (#17). Illustrator gives a Group or Layer its own Fills and Strokes, and its Appearance panel shows the children as one entry, **Contents**, which the designer drags above or below the container's paints. Kalamo takes those semantics. This ADR covers Live Shape and Path descendants with solid paints (#103), texts and Clipping Masks (#106), gradients (#107), SVG import (#104) and the browser canvas (#105).

## The model

- `LayerNode` and `GroupNode` gain an optional `appearance {fills, strokes, contents}`. `fills` and `strokes` are the leaf's `Fill` and `Stroke`. `contents` is an integer from 0 to `fills.length + strokes.length`: how many paints, counted from the first Fill up through the Strokes, draw below the children. 0, the default, puts every paint above, as Illustrator does with a new paint.
- Missing means empty, so files saved before this open unchanged and `version` stays 1. `node_get` `full` reports `{fills: [], strokes: [], contents: 0}` for a container without one. An omitted `appearance` on `node_create` stores nothing: Illustrator has no default paint for a container.
- `node_update` merges it by RFC 7396 like a leaf's, and `appearance: null` removes it. `contents` outside its range, after the merge too, is the new error code `INVALID_INPUT` with `path` `…appearance.contents`. A leaf's patch with `contents` is `INVALID_PATCH` with a hint; `node_create` drops it, as it drops any key a type does not have (since ADR-0050 it refuses it with `INVALID_INPUT`). A Fill cannot sit above a Stroke, the limit a leaf has too.
- A Fill or Stroke may be a gradient, with a leaf's inline shape, defaults and validation (ADR-0026) (#107). Illustrator runs a Group's gradient as one field across every object in it, so its geometry is in document coordinates: a container has no matrix (ADR-0007), and its own coordinates are the Document's. Geometry left out takes a leaf's placement on the container's `geometricBounds` instead of the leaf's own bounds, measured after the write, so a `node_create` with inline `children` fits them. A container without bounds (nothing in it) cannot place it: `INVALID_INPUT` at `…appearance.fills[i].gradient` (or `strokes[i]`), with a hint to give `start`/`end` or `center`/`radius`; explicit geometry is taken. Like a leaf's, the gradient is not refitted when children change; sending it again without geometry refits it.

## What it paints

A container draws, bottom to top: paints `0 … contents − 1`, its children as before, then the remaining paints. Each paint goes over every leaf the container paints before the next paint starts, so one container Stroke is one layer over all the children (Illustrator's group Stroke), and a Stroke below Contents reads as one outline around their union.

One core function, `paintedLeaves`, lists those leaves: the visible descendant Live Shapes, Paths and texts, depth first in stacking order, each with its world outline and its fill rule (a Live Shape's is nonzero), and the Clipping Path of every inner Clipping Mask it sits in. It skips hidden Nodes and hidden subtrees, Images (no Appearance, ADR-0023) and Clipping Paths (never painted, ADR-0021). Every renderer draws from this list, so `render` and the canvas cannot disagree. A Clipping Mask Group's own paints are clipped with its content, because they sit inside its clipped `<g>`. A gradient paint is one field in document coordinates over every leaf; the canvas draws a text under its transform, so it maps the gradient back through that transform, as the SVG's text copies do, and it draws an elliptical radial gradient exactly on shape Fills and as its circle on Strokes and text, a leaf's ceiling (ADR-0026).

A text has no outline until Create Outlines (F-TEXT-06), so a container paint draws its glyphs as the text lays them out, in the text's own transform; its outline in the list is its frame, which bounds and hit tests use as they do for the text itself. A container Fill paints every glyph in its own colour: a text's Character Range Fills are the text's own and paint only where the text's own Fills do (ADR-0029). A container Stroke's width stays in document units, so on a scaled text it is divided by √|det| of the text's transform. A leaf inside an inner Clipping Mask is painted only inside that mask's Clipping Path, as its own paint is.

## Bounds

`geometricBounds` of a container stays the union of its children's, as in Illustrator, so alignment and pivots ignore Stroke width. `visibleBounds` adds each painted leaf's world outline bounds grown by half the widest container Stroke. The outline is in document coordinates, so no leaf matrix scales it.

## Transforms

A container has no matrix (ADR-0007), so nothing scales its Strokes the way a leaf's matrix scales a leaf's. `node_transform` therefore treats container Strokes as leaf Strokes look: with `scaleStrokes: true` (the default) every container in the transformed subtrees has its Stroke `width` and `dash` multiplied by √|det| of the matrix, the factor a leaf divides by for `false`; with `false` they stay as they are, which keeps the rendered width. Every gradient Fill and Stroke of those containers maps through the same matrix whatever `scaleStrokes` says, so the field afterwards is the old one transformed, as a Group's gradient moves in Illustrator: a linear one stays linear with its end recomputed so the stops keep their places, a radial one becomes the ellipse the map makes, its focus mapped. With `each: true` each target's subtree takes its own matrix. Such containers are listed in `updatedIds`. Transforming only a descendant leaf leaves its containers' Strokes and gradients as they are, so a moved child slides through the field.

Import keeps the same rule (#108): a container that another editor transformed imports as that container transformed by `node_transform` with the same matrix and `scaleStrokes: true`. Its children take the composed matrix as any leaf does, and its Strokes take √|det| of the matrix composed at the paint group (ancestors, root unit scale, the container's own transform and the paint group's own). A container gradient maps through that same matrix, exactly, with no warning.

## SVG

This amends ADR-0017's mapping table with a row:

| Kalamo | SVG |
|---|---|
| Container Appearance | inside the container's `<g>`, each Fill then each Stroke is a `<g kalamo:paint="true" sodipodi:insensitive="true" inkscape:label="Fill"\|"Stroke">` carrying the paint (`fill`, or `fill="none"` and the `stroke` attributes) and one bare copy per painted leaf, with no id: a `<path>` of its world outline, `fill-rule="evenodd"` where set, or a `<text>` laid out as the text writes itself, in its own `transform`, without its Character Range Fills. A copy inside inner Clipping Masks sits in one `<g clip-path>` per mask, outermost first, that reuses the mask's `<clipPath>` id. The groups below Contents come before the children and the rest after, so document order is paint order. A gradient is a `fill="url(#…)"` or `stroke="url(#…)"` on its group and a `<defs>` just before the group holding it as a leaf's is written (ADR-0026), not inside the group, where Inkscape 1.2.2 never finishes updating the document; id `fill-<i>-z-<container ULID>` or `stroke-<i>-z-<container ULID>`. SVG resolves `userSpaceOnUse` in the user space of the element that paints, so a text copy with a transform paints with its own gradient, the container's mapped through the inverse of that transform, id `…-<text ULID>`, in the same `<defs>`; shape copies are in document coordinates and use the group's |

Why one copy per leaf and not one combined `d`: under nonzero, one path of every outline leaves holes where outlines of opposite winding overlap, and Illustrator paints each object on its own. The copies are locked and labelled so a designer in Inkscape sees what they are and cannot move them. They are derived, so import (#104) reads the paint from each group and ignores the copies:

- In a `<g>` read as a Layer or Group, each direct child `<g kalamo:paint>` is one Fill, or when its fill is none one Stroke, resolved like a leaf's paint; a hidden one is no paint. `contents` is the number of paints before the first other drawn child. A designer who deletes a paint group removes that paint, and one who moves a child leaves no stale outline, since export redraws the copies from the children.
- A paint group anywhere else (at the root, outside every Layer) is dropped with `UNSUPPORTED_ELEMENT`. A gradient paint reads by the leaf rules (ADR-0026: `href` chains, `gradientTransform`, spread unrolled, degenerate gradients made solid), `objectBoundingBox` against the paint group's bounding box, its copies' boxes through their transforms. The copies' own gradients are ignored with the copies. A Fill group above a Stroke group reads in fills-then-strokes order with `UNSUPPORTED_ATTRIBUTE`, since a Fill cannot sit above a Stroke.
- Under a transform, a gradient maps through the matrix composed at its paint group, and a Stroke's `width` and `dash` are multiplied by √|det| of the matrix composed at its paint group (see Transforms). Inkscape's rotate, scale and flip write the matrix on the container's `<g>` and leave the paint group's `stroke-width` as it was, so a similarity (rotation, uniform scale, reflection and their compositions; orthogonal columns `u`, `v` of equal length, where `|u·v|` and `||u|² − |v|²|` are each below 1e-6 × (`|u|² + |v|²`)) imports exactly and silently (#109). Inkscape 1.2.2 writes rounded rotations symmetric (`[a, b, −b, a]`), which compose exactly, so the tolerance is for writers that round each entry on its own: 1e-6 accepts any writer at 7 or more significant digits with room for nesting, and rejects anything a person can enter in Illustrator, whose smallest Scale step (100.001%, 1e-5) and Shear angle (0.01°, about 1.7e-4) are far above it. An accepted departure varies the drawn width by under one part in a million. Leaf baking (ADR-0017) uses the same 1e-6. Under skew or non-uniform scale Inkscape draws a Stroke whose width varies with direction, which one width in document units cannot hold; Illustrator never draws such a Stroke either (transforming a Group bakes the transform into its paths, and Scale Strokes & Effects scales a width by one factor), so the Stroke takes √|det| with one `UNSUPPORTED_ATTRIBUTE` per import. A paint group whose own transform flattens it is dropped with `INVALID_TRANSFORM` and not counted in Contents; an unreadable one is ignored.
- A plain `<g fill>` from another editor is SVG inheritance, not a container Appearance, and imports as before: its children inherit the paint.

Open and Place both read them, so Place and paste keep container Appearance on the Groups they make, Layers that become Groups included.

## Considered Options

- **Children inherit the container's paint, as SVG `<g fill>` does.** That is not Illustrator's model: a child's own Appearance would hide the container's, and Contents could not be placed.
- **A matrix on the container, so Strokes scale by themselves.** Rejected by ADR-0007.
- **Contents as a marker entry in one mixed paint list.** Allows a Fill above a Stroke, which no leaf can express; an index into the fixed fills-then-strokes order is enough.

## Consequences

- `ErrorCode` gains `INVALID_INPUT` (F-MCP-15). ADR-0050 widens it to every argument the input schema rejects.
- `render` and the browser canvas draw container paints from the same `paintedLeaves` list, and a click on one hits the leaf it paints (#105): the Selection tool picks its object, Direct Selection the leaf.
- A container Stroke's width is in document units and changes on `node_transform`, so a Group scaled with `scaleStrokes: false` and back with `true` does not return to its first width; the same holds for leaves.
