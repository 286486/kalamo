---
status: accepted
date: 2026-09-27
---

# A container's Appearance paints its descendants' outlines

CONTEXT.md and F-DOC-04 say a Layer or Group can carry an Appearance, but only leaves took one, and `node_create` dropped a Group's `appearance` without a word (#17). Illustrator gives a Group or Layer its own Fills and Strokes, and its Appearance panel shows the children as one entry, **Contents**, which the designer drags above or below the container's paints. Zibel takes those semantics. This ADR covers Live Shape and Path descendants with solid paints (#103); texts and Clipping Masks (#106), gradients (#107), SVG import (#104) and the browser canvas (#105) follow under the same rules.

## The model

- `LayerNode` and `GroupNode` gain an optional `appearance {fills, strokes, contents}`. `fills` and `strokes` are the leaf's `Fill` and `Stroke`. `contents` is an integer from 0 to `fills.length + strokes.length`: how many paints, counted from the first Fill up through the Strokes, draw below the children. 0, the default, puts every paint above, as Illustrator does with a new paint.
- Missing means empty, so files saved before this open unchanged and `version` stays 1. `node_get` `full` reports `{fills: [], strokes: [], contents: 0}` for a container without one. An omitted `appearance` on `node_create` stores nothing: Illustrator has no default paint for a container.
- `node_update` merges it by RFC 7396 like a leaf's, and `appearance: null` removes it. `contents` outside its range, after the merge too, is the new error code `INVALID_INPUT` with `path` `…appearance.contents`, and so is a gradient paint until #107. A leaf's patch with `contents` is `INVALID_PATCH` with a hint; `node_create` drops it, as it drops any key a type does not have. A Fill cannot sit above a Stroke, the limit a leaf has too.

## What it paints

A container draws, bottom to top: paints `0 … contents − 1`, its children as before, then the remaining paints. Each paint goes over every leaf the container paints before the next paint starts, so one container Stroke is one layer over all the children (Illustrator's group Stroke), and a Stroke below Contents reads as one outline around their union.

One core function, `paintedLeaves`, lists those leaves: the visible descendant Live Shapes and Paths, depth first in stacking order, each with its world outline and its fill rule (a Live Shape's is nonzero). It skips hidden Nodes and hidden subtrees, Images (no Appearance, ADR-0023) and Clipping Paths (never painted, ADR-0021). Until #106 it also skips texts and the content of an inner Clipping Mask. Every renderer draws from this list, so `render` and the canvas cannot disagree. A Clipping Mask Group's own paints are clipped with its content, because they sit inside its clipped `<g>`.

## Bounds

`geometricBounds` of a container stays the union of its children's, as in Illustrator, so alignment and pivots ignore Stroke width. `visibleBounds` adds each painted leaf's world outline bounds grown by half the widest container Stroke. The outline is in document coordinates, so no leaf matrix scales it.

## Transforms

A container has no matrix (ADR-0007), so nothing scales its Strokes the way a leaf's matrix scales a leaf's. `node_transform` therefore treats container Strokes as leaf Strokes look: with `scaleStrokes: true` (the default) every container in the transformed subtrees has its Stroke `width` and `dash` multiplied by √|det| of the matrix, the factor a leaf divides by for `false`; with `false` they stay as they are, which keeps the rendered width. Such containers are listed in `updatedIds`. Transforming only a descendant leaf leaves its containers' Strokes as they are.

## SVG

This amends ADR-0017's mapping table with a row:

| Zibel | SVG |
|---|---|
| Container Appearance | inside the container's `<g>`, each Fill then each Stroke is a `<g zibel:paint="true" sodipodi:insensitive="true" inkscape:label="Fill"\|"Stroke">` carrying the paint (`fill`, or `fill="none"` and the `stroke` attributes) and one bare `<path>` per painted leaf: its world outline, `fill-rule="evenodd"` where set, no id. The groups below Contents come before the children and the rest after, so document order is paint order |

Why one copy per leaf and not one combined `d`: under nonzero, one path of every outline leaves holes where outlines of opposite winding overlap, and Illustrator paints each object on its own. The copies are locked and labelled so a designer in Inkscape sees what they are and cannot move them. They are derived, so import (#104) reads the paint from each group and ignores the copies. Until then, import drops the paint groups without a warning, so a file exported with a container Appearance opens without it.

## Considered Options

- **Children inherit the container's paint, as SVG `<g fill>` does.** That is not Illustrator's model: a child's own Appearance would hide the container's, and Contents could not be placed.
- **A matrix on the container, so Strokes scale by themselves.** Rejected by ADR-0007.
- **Contents as a marker entry in one mixed paint list.** Allows a Fill above a Stroke, which no leaf can express; an index into the fixed fills-then-strokes order is enough.

## Consequences

- `ErrorCode` gains `INVALID_INPUT` (F-MCP-15).
- `render` covers container paints; the browser canvas does not draw them until #105.
- A container Stroke's width is in document units and changes on `node_transform`, so a Group scaled with `scaleStrokes: false` and back with `true` does not return to its first width; the same holds for leaves.
