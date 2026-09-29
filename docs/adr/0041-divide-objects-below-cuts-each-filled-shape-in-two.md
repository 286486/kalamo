---
status: accepted
date: 2026-09-27
---

# Divide Objects Below cuts each filled shape below in two

Object > Path > Divide Objects Below (F-PATH-03, #90) is a cookie cutter: the selected object cuts through every object below it that it overlaps, and the cutter is then discarded (research 06 §5). Adobe's page does not say which objects are cut or how the pieces are stored, so this ADR decides both.

## Decision

**`path_op divide_below` takes exactly one path or Live Shape in `nodeIds`, the cutter.** The browser's menu item is enabled only when the Selection holds one path or Live Shape, as Illustrator's needs one selected object.

- A Clipping Path, or a hidden or locked Node, cannot be the cutter. The cutter cuts every path and Live Shape below it in paint order, in any Layer or Group, when the shape has a Fill, is not a Clipping Path, is visible and unlocked with its ancestors (as Clean Up requires, ADR-0040), and its bounds overlap the cutter's. Texts, images, unfilled paths and Clipping Paths are left as they are. The cutter's own Fill and Stroke do not matter: its fill area under its fill rule does the cutting, an open subpath filled as if closed.
- Each cut shape becomes two paths, the fill outside the cutter and the fill inside it, from Skia PathOps `DIFFERENCE` and `INTERSECT` in document coordinates (ADR-0034) and brought back into the shape's own coordinates. The outside keeps the shape's id and stacking place, and the inside is a new path directly above it. Both keep the shape's appearance, name, transform, opacity and blend mode, with fill rule evenodd as in ADR-0039. A shape wholly inside the cutter becomes its inside piece and keeps its id. A Live Shape cut is converted, with `CONVERTED_TO_PATH`.
- A piece made of several disjoint regions stays one path with several subpaths, like Illustrator's Compound Path results. The pieces are not split further into separate objects.
- The cutter is deleted. When nothing below overlaps it, the call fails with `INVALID_PATH` and changes nothing, instead of deleting the cutter alone.

## Consequences

- A cut shape's Stroke is kept on both pieces, so it now strokes the cut edges too. Illustrator's handling of Strokes, of stroke-only and open paths below, and whether it splits disjoint regions into separate objects should be checked in a live Illustrator when one is available.
- The geometry `divide` op is the first Skia boolean in `@kalamo/geometry`; Pathfinder (F-BOOL-02) can build on the same `op` calls.
