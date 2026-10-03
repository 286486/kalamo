---
status: accepted
date: 2026-09-27
---

# Simplify refits the path as Ink, and its slider is a tolerance

Object > Path > Simplify reduces a path's Anchors (F-PATH-03, #86). Adobe documents the controls (research 06 §5) but not the algorithm or what the slider measures. ADR-0033 already gives core one fit for Ink.

## Decision

**`path_op simplify {tolerance, cornerAngle, toLines}` traces each subpath as Ink and fits it with `fitInk`.** The Ink is points along the subpath, through every Anchor, half the tolerance apart (at least 16 and at most 10,000 per subpath). The fit keeps the ends of an open subpath and keeps a closed one closed, whatever its ends. A subpath with no length stays as it is.

- **`tolerance`** is the most the result may stray, in document units, measured in each path's own coordinates after dividing by its transform's scale, as Join does. The default is 1 pt, the same as the Pencil's default Fidelity.
- **`cornerAngle`** is Illustrator's Corner Point Angle Threshold, in degrees, 90 by default. The angle is the one between a turn's two sides, so 180° is straight on. A Corner Anchor whose angle on the Ink is at most the threshold stays a corner, so a right angle stays a corner at the default. Only Corner Anchors can: a Smooth Anchor never becomes a corner, so at 180° every Corner Anchor stays one and the Smooth ones are refitted. The Pencil's fixed 60° turn is a threshold of 120°.
- **`toLines`** is Convert to Straight Lines, "straight lines between the original anchor points" (Adobe): Douglas–Peucker over the Anchors, dropping each one that the line between its kept neighbours passes within the tolerance of the traced path. Only `L` segments are left, and every Anchor is an original one. Where no line between kept Anchors follows the path within the tolerance, every Anchor between stays.

**Simplify changes a subpath only when the fit has fewer Anchors** (#311). Without `toLines`, each subpath is fitted as above, and one whose fit has as many Anchors as it has, or more, keeps its own Anchors unchanged. Illustrator's Simplify removes Anchors (research 06 §5), but a refit from scratch does not know where the original Anchors were: rounding a Corner Anchor above the threshold within the tolerance costs at least one more Anchor, and a smooth curve refitted at a tight tolerance needs more cubics than drew it. A hexagon went from 6 Anchors to 12 at the default 1 pt, and a 4-Anchor circle to 10 at 0.01. Convert to Straight Lines keeps a subset of the original Anchors, so it never adds any and is not compared.

**The browser's slider is a Fidelity in screen px.** It runs from Minimum to Maximum Anchors, and it maps a position `s` from 0 to 100 to `fidelityTolerance(100 − s)` divided by the current zoom; zooming while it is open refits. That is 10 px at Minimum, 1 px at the middle and 0.1 px at Maximum. Auto-Simplify is the middle, so the result stays within a pixel of the path on screen.

**Simplify previews in the browser and commits once.** The menu item previews the auto result at once and shows the on-canvas bar. The bar and the More Options dialog change only a local preview, which runs core's `pathOp` on a copy of the Document. OK sends one `path_op` Command, so one Transaction. Cancel or Esc sends nothing.

## Considered Options

- **Equal counts take the fit.** The fit is then never simpler than the original, only different: it rounds every corner of a hexagon at tolerance 2 and 5, and puts two of a circle's 4 Anchors 2.4 pt from the other two, which move again on every repeat. With fewer only, repeating Simplify on a subpath it cannot shorten changes nothing.
- **Keeping every Corner Anchor a corner as a second try before falling back.** It only helps a few-Anchor polygon that also has a redundant Anchor, such as a 5-Anchor polygon with one Anchor on a line, which would end at 4 instead of 5. It waits until someone needs it.
- **Fitting with the original Anchors as candidate split points.** It would fix the cause for smooth curves, but it is a new fitting algorithm for the same observable guarantee.

## Consequences

- A subpath Simplify cannot shorten stays exactly as it was, Corner Anchors included, so an obtuse corner on a path with no Anchors to spare stays a corner whatever the Corner Point Angle Threshold. The threshold rounds a corner only where the fit also saves an Anchor.
- Simplifying the Anchors selected with Direct Selection, a region of the path, waits. Simplify always works on whole paths.
- "Retain my latest settings and directly open this dialog" waits.
- A Smooth Anchor never becomes a corner, however tightly its curve bends.
- Convert to Straight Lines on a path with few Anchors, such as a circle's four, is their polygon, as far from the curve as that is: the tolerance only decides which Anchors go.
