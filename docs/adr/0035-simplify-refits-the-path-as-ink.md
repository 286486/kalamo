---
status: accepted
date: 2026-09-27
---

# Simplify refits the path as Ink, and its slider is a tolerance

Object > Path > Simplify reduces a path's Anchors (F-PATH-03, #86). Adobe documents the controls (research 06 §5) but not the algorithm or what the slider measures. ADR-0033 already gives core one fit for Ink.

## Decision

**`path_op simplify {tolerance, cornerAngle, toLines}` traces each subpath as Ink and fits it with `fitInk`.** The Ink is points along the subpath, through every Anchor, half the tolerance apart (at least 16 and at most 10,000 per subpath). The fit keeps the ends of an open subpath and keeps a closed one closed, whatever its ends. A subpath with no length stays as it is.

- **`tolerance`** is the most the result may stray, in document units, measured in each path's own coordinates after dividing by its transform's scale, as Join does. The default is 1 pt, the same as the Pencil's default Fidelity.
- **`cornerAngle`** is Illustrator's Corner Point Angle Threshold, in degrees, 90 by default. The angle is the one between a turn's two sides, so 180° is straight on. Where the angle is at most the threshold, the fit keeps a Corner Anchor, so a right angle stays a corner at the default. The Pencil's fixed 60° turn is a threshold of 120°.
- **`toLines`** is Convert to Straight Lines: Douglas–Peucker over the same Ink with the same tolerance, so only `L` segments are left.

**The browser's slider is a Fidelity in screen px.** It runs from Minimum to Maximum Anchors, and it maps a position `s` from 0 to 100 to `fidelityTolerance(100 − s)` divided by the zoom. That is 10 px at Minimum, 1 px at the middle and 0.1 px at Maximum. Auto-Simplify is the middle, so the result stays within a pixel of the path on screen.

**Simplify previews in the browser and commits once.** The menu item previews the auto result at once and shows the on-canvas bar. The bar and the More Options dialog change only a local preview, which runs core's `pathOp` on a copy of the Document. OK sends one `path_op` Command, so one Transaction. Cancel or Esc sends nothing.

## Consequences

- Simplifying the Anchors selected with Direct Selection, a region of the path, waits. Simplify always works on whole paths.
- "Retain my latest settings and directly open this dialog" waits.
- A curve that bends tighter than about the tolerance can read as a corner, since corners are found on the traced Ink.
