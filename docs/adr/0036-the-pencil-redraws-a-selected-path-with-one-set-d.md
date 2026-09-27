---
status: accepted
date: 2026-09-27
---

# The Pencil redraws or extends a selected path with one `set_d`, and its options live in the browser

The Pencil (#83, F-DRAW-06, F-FREE-01/02/04) draws new paths and edits selected ones. Adobe documents what a Pencil drag does (research 06 §3) but not the exact rules for which part of a path it replaces.

## Decision

**Ink is fitted on release with `fitInk` (ADR-0033) at a tolerance of `fidelityTolerance(fidelity)` screen px**, so Fidelity follows the zoom. Pointer positions come from `getCoalescedEvents`. While dragging, the browser draws the raw Ink as a polyline. Ink whose ends are within the close distance becomes a closed path, because the Ink is ended on its first point.

**Ink that starts within the edit distance of a selected, editable path edits the nearest such path**, as one `path_edit` with a single `set_d`. All of the geometry work happens in the browser, in document coordinates, and the result is mapped back into the path's own coordinates. Only the subpath the Ink starts on changes. Ink that never leaves the edit distance of where it started on the path is not an edit, so a wiggle cannot cut the path.

- **From an open subpath's Endpoint, the Ink extends it.** The path keeps its direction. If the Ink ends within the close distance of the other Endpoint, the subpath closes.
- **From anywhere else on the path, the Ink redraws part of it.** If the Ink ends within the edit distance of the same subpath, it replaces the part between its two ends. On a closed subpath, the replaced arc is the one the Ink heads along from its start. If the Ink ends away from the path, it replaces everything from its start to the end it heads toward. The direction is measured against the path's tangent. A closed subpath redrawn this way opens at the start.

**Alt draws a straight segment, and Shift draws one at a multiple of 45°.** The segment starts where the modifier was first seen. Releasing the modifier continues freehand from the end of the segment, so pressing it again starts another segment.

**Pencil Tool Options are per-browser settings in `localStorage`**, not Document state. They are Fidelity (five stops), Fill new pencil strokes (default off), Keep selected (default on), Close paths within 15 px, and Edit selected paths within 12 px. Double-clicking the tool opens them.

## Consequences

- Undo takes back the whole drag, as for the Pen (ADR-0032).
- These Illustrator options and gestures are not implemented yet: connecting two paths with one drag, Alt toggling to the Smooth tool, Live curve fitting, the cursor's star and continuation icons, and the legacy close gesture (F-DRAW-06's "Ctrl closes").
- A freehand run that meets a straight segment at less than 60° is fitted as a curve through the join (ADR-0033's corner threshold).
