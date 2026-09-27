---
status: accepted
date: 2026-09-27
---

# Clean Up acts on the whole Document; Split Into Grid gives each shape its own grid

Object > Path > Clean Up and Split Into Grid (F-PATH-03, #89) follow research 06 §5. Four points the research leaves open are decided here.

## Decision

**`path_op clean_up {strayPoints, unpainted, emptyText}` ignores `nodeIds`** and scans the whole Document, as Illustrator's command does. `nodeIds` now defaults to `[]`, and every other op fails with `INVALID_PATH` at `nodeIds` when it is empty.

- A Stray Point is a subpath of one Anchor, so a path that also has drawn subpaths keeps them and is updated; a path left with none is deleted. Illustrator's Compound Path is a set of PathItems, each of which can be a stray point.
- Unpainted means a Live Shape or path with no Fill and no Stroke. Clipping Paths never paint (ADR-0021) and are kept.
- A text's content cannot be empty (`TextShape.content` has `min(1)`), so `emptyText` removes texts of only spaces and hard returns, which draw nothing.
- Hidden and locked Nodes, or those under a hidden or locked Layer or Group, are kept: Illustrator's Clean Up works on what can be selected.
- Nothing to remove fails with `INVALID_PATH` instead of committing an empty Transaction. The browser runs core on a copy first, so its notice can say how many objects went, or that there was nothing, without a round trip.

**`path_op split_into_grid {rows, cols, gutter, totalWidth?, totalHeight?}` replaces each closed path or Live Shape with its own grid** over its geometric bounds in document coordinates. The rects have no transform (containers carry none, ADR-0007), the original's name, opacity and blend mode, and new ids, stacked row by row from the top left where the original was; the original is deleted. Every rect takes the topmost selected shape's appearance, as Adobe documents for several objects (research 06 §5). Open paths, lines and Clipping Paths are skipped.

- One `gutter` serves rows and columns; Illustrator has one per axis. Totals default to the shape's size; the cell size follows from Number, Gutter and Total, so the API does not take Height or Width.
- Add Guides waits for guides.

## Consequences

- A gradient's geometry is copied as stored, in the original's coordinates, so a gradient on a transformed shape shifts on its rects.
- Separate row and column gutters are one more field when someone asks for them.
