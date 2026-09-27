---
status: accepted
date: 2026-09-27
---

# Outline Stroke puts the Fill below each outlined Stroke in a Group that composites them

Object > Path > Outline Stroke (F-PATH-03, #87) turns a Stroke into a filled path. Adobe says only that the result is a compound path, "grouped with the filled object" when there is a Fill (research 06 §5). Our Appearance can hold several Strokes, and a Node's opacity and blend mode apply to the whole Node.

## Decision

**`path_op outline_stroke` makes one path per Stroke, filled with the Stroke's paint.** The outline is computed by `@zibel/geometry` (ADR-0034): Skia's stroker with the Stroke's width, cap, join and miter limit, then `simplify`, so the contours do not overlap and fill the same under nonzero and evenodd. The path gets fill rule nonzero.

- **One Stroke and no Fill:** the Node becomes the outline in place, keeping its id and everything else.
- **Otherwise:** a new Group takes the Node's parent, stacking position, opacity and blend mode. The Node moves into it, keeping its id and only its Fills, with opacity 1 and blend mode normal. Above it come the outlined Strokes as new paths, bottom to top as the Appearance paints them. Moving opacity and blend mode to the Group keeps the render the same: two half-transparent children would show the Fill through the inner half of the Stroke.
- A Live Shape is converted to a path first, with `CONVERTED_TO_PATH`, as Illustrator expands it. A Node without a Stroke, or a Clipping Path, is left as it is. The call fails with `INVALID_PATH` when none of the Nodes has one.
- **Dashes:** PathKit dashes with one dash and one gap. A longer pattern runs as one pass per dash, that dash on and the rest of the period off, with the phase set to where the dash starts. Together the passes lay out the whole pattern. An odd-length pattern is repeated first, as SVG does.

**Core takes the geometry as an argument.** `pathOp(doc, input, geometry?)` gets a `Geometry` with a synchronous `outlineStroke`, because a Durable Object edit is synchronous. The Document Durable Object awaits `loadGeometry()` before the edit, inside `blockConcurrencyWhile` so no other event runs while PathKit instantiates. It keeps the result for later calls. A browser `path_op` Command therefore makes `webSocketMessage` async.

## Consequences

- The outline has Skia's Anchor count, more than Illustrator's (ADR-0034). Simplify can reduce it.
- The pixel check renders at 8 pixels per point. At 2, resvg's own round caps, which it flattens before zooming, are 1.4% off a true circle, while the outline's cubics match one exactly. Dashes are checked on straight segments: along curves resvg and Skia measure length slightly differently, so dashes drift by a fraction of a point.
- Stroke alignment (inside, outside), arrowheads, variable width and brushes do not exist yet, so Outline Stroke ignores them.
