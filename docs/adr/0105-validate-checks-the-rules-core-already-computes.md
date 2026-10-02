---
status: accepted
date: 2026-10-02
---

# `validate` checks the rules core already computes

F-MCP-13 makes `validate` P0, and M1 lists it: an Agent should check its work after each logical stage without reading every Node back (#259). Until now the only checks were a write's receipt warnings, and only for the Nodes that write touched. A frame that a later edit made overflow, or a shape moved off its Artboard, went unnoticed until someone rendered it and looked. REQUIREMENTS §6.4 lists nine checks. This ADR picks the ones core can already compute and names the rest as follow-ups.

## Decision

**One read-only tool, `kalamo_validate {docId, scope?, rules?, txId?}`, returns `{rev, issues: [{rule, nodeId, message, hint?}]}`.** It reads the way `doc_outline` does: from the Document Durable Object, through the open Transaction's overlay when `txId` is given and the caller's Actor holds it, at the committed `rev`. A viewer can call it (ADR-0047). It never writes, and no write calls it.

- **Rules.** `rules` names a subset, at least one. Omitted, every rule runs. An unknown name is `INVALID_INPUT` at `rules[i]`, and the hint lists the rules (ADR-0050).
  - `font_missing`, `missing_glyphs` and `text_overflow`: the warnings `textWarnings` gives a write's receipt (`FONT_MISSING`, `MISSING_GLYPHS`, `TEXT_OVERFLOW`, ADR-0017, ADR-0022, ADR-0062), worked out for each text on its own. Unlike Open and Place, the warnings are not merged once per file: every text in a missing face is listed.
  - `missing_link`: an Image with no `src`, a missing link (ADR-0042).
  - `zero_area`: a Live Shape or path whose points (anchors and control points, in document coordinates) all lie within 0.001 pt of one point, or a closed one (`Z` in its outline) that fills nothing under its fill rule. Its subpaths are closed as their fill closes them and its curves cut into 16 straight edges evenly in `t`; it fills nothing when every stretch of every line its edges lie on (within 0.001 pt) is crossed a net zero times, or an even number under evenodd, because winding steps by that count at each edge. So a closed shape on one line, a path that goes out and back along the same lines or curve, a square with the same square wound the other way, and a square traced twice under evenodd are all flagged, while a bowtie, whose lobes cancel in signed area but both fill, is not. 0.001 pt is the precision the Document stores coordinates at (`round3`). An open shape with length, such as a Line, has no area to lose and is never flagged, whatever its height. Text and Images are not checked: an Image's frame is always positive, and empty text is a separate rule.
  - `empty_group`: a Group with no children. A Layer may be empty; Illustrator keeps empty Layers as places to draw.
  - `outside_artboards`: a Node other than a Layer whose `visibleBounds` touch no Artboard, edges included, so no Artboard export draws it. Only the highest such Node is listed, so a Group dragged off the Artboards is one issue, not one for each Node inside it. A Node with no bounds (an empty Group) is never outside. An Opacity Mask's mask paints nothing of its own, so neither it nor its contents are checked.
- **Scope.** `scope` takes `render`'s `{artboardId}` and `{nodeIds}` forms. `{rect}` is not accepted. Omitted, it means the whole Document. `{nodeIds}` checks those Nodes and what they contain, and an unknown id is `NODE_NOT_FOUND` at `scope.nodeIds[i]`. `{artboardId}` checks the Nodes whose `visibleBounds` touch that Artboard, so `outside_artboards` never fires under it and an empty Group, which has no bounds, is not checked. An unknown Artboard is `ARTBOARD_NOT_FOUND` at `scope.artboardId`, the same error `render` gives (core's `artboardOf` now serves both).
- **Skipped.** A hidden Node and a Template Layer (ADR-0099) are skipped with everything inside them. A hidden Node draws nothing, and a Template Layer is a reference that no export writes.
- **Order.** Issues are in drawing order, bottom first, as `paintOrder` walks the tree. A Node's own issues follow `ValidateRule`'s order: `font_missing`, `missing_glyphs`, `text_overflow`, `missing_link`, `zero_area`, `empty_group`, `outside_artboards`. The same Document and arguments always give the same list.
- **Workflow.** skill://kalamo/drawing-conventions tells an Agent to call `kalamo_render` and `kalamo_validate` after each logical stage, and to fix what they show before the next stage.

## Considered Options

- **Run `validate` from every write's receipt.** Rejected: receipts already carry the warnings for the Nodes a write touched, and checking the whole Document on every write costs time on large Documents and output tokens on every call.
- **One issue for every Node off the Artboards.** Rejected: one Group of a hundred Nodes moved off an Artboard would list a hundred issues and one fix.
- **Measure the filled area for `zero_area` with Skia.** Rejected: Skia (ADR-0034) is loaded only for path operations, and a filled area measured from pixels or flattened outlines needs a threshold of its own. Net edge counts are exact for straight edges and need no new dependency.
- **Only test that the points lie on one line.** Rejected: it misses closed paths that fill nothing but whose bounds have area, such as one that goes out and back, which the issue asks to flag.

## Consequences

- The tool definition costs 1,679 bytes. The tool-definition total went from 104,897 to 106,576 of the 112,000-byte budget (ADR-0088), so the budget is unchanged.
- A curve cancels only a curve traced back along the same control points: another curve of the same shape with other control points is cut into other edges. Each line scans the edges left, so a path that does cancel costs edges × lines. The code marks both with `ponytail:` comments.
- Known follow-ups from §6.4's list, each a later rule: open paths that should be closed, overlapping text, non-integer Stroke widths (F-ILL-06), unused assets, tiny objects, and empty text. `scene_describe` (F-MCP-12) is a separate ticket.
