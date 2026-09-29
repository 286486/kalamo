---
status: accepted
date: 2026-09-29
---

# The grid tools draw a Group of Live Shapes

REQUIREMENTS F-DRAW-01 lists Rectangular Grid and Polar Grid among the shape tools and says every one but Arc makes a Live Shape. Neither grid does in Illustrator. This ADR records what Kalamo's Rectangular Grid tool (#150) and Polar Grid tool (#151) draw, and amends F-DRAW-01 for both grids.

## Why a Group

- **Illustrator makes a Group.** A drag with Illustrator's Rectangular Grid tool leaves a Group of plain paths: an outer rectangle and one path per divider. The Polar Grid tool's Group holds the ellipses and the radial lines. Once drawn, neither has a divider count or skew left to edit. The Tool Options only set up the next drag, like the Arc tool's (ADR-0059).
- **Nothing round-trips a grid.** Inkscape has no grid object, so a Live grid would export as a Group of plain elements and come back as one, against ADR-0017's lossless round trip.

Each tool sends one `create` (ADR-0032) of a `group` whose inline children are its Live Shapes, through the shared pending create (#141). The Group, not its children, becomes the Selection: a `tx` that answers drawn art selects each created Node whose parent it did not also create.

## The Rectangular Grid's children

In stacking order, bottom to top:

1. **The frame**, a `rect` Live Shape spanning the drag: Illustrator's Use Outside Rectangle As Frame, on by default.
2. **The horizontal dividers**, from the top down, then **the vertical dividers**, from the left: one `line` Live Shape each, from one side of the frame to the other.

A divider is a `line` Node, not an open Path: it is one straight segment, which is exactly a Live Line, and it exports as `<line>`. A count of 0 leaves only the frame.

## The Rectangular Grid's geometry

The frame is `dragBox`'s box: Shift makes it a square, Alt centres it on the press, and Space moves it, as with the Rectangle tool. A drag flat as a line, or back to a point, draws nothing.

`n` dividers split a side into `n + 1` cells. Skew `s`, in percent, makes each cell `q = 2^(−s/100)` times the one before it, so the cells shrink or grow geometrically toward one side. Divider `i`, from 1 to `n`, lies at the fraction

- `f_i = i / (n + 1)` when `s = 0`, evenly spaced;
- `f_i = (1 − q^i) / (1 − q^(n+1))` otherwise.

Positive skew packs the dividers toward the high end, `f` near 1, and `−s` mirrors `s` exactly: `f_i(−s) = 1 − f_(n+1−i)(s)`. At 100% each cell is half the one before it. Following the ends of Illustrator's Skew sliders, Bottom…Top and Left…Right:

- a horizontal divider lies at `y = bottom − f·height`, so positive skew packs them toward the top;
- a vertical divider lies at `x = left + f·width`, so positive skew packs them toward the right.

## The Polar Grid's children

In stacking order, bottom to top:

1. **The outer ellipse**, an `ellipse` Live Shape filling the drag's box.
2. **The concentric dividers**, from the centre out: one `ellipse` Live Shape each, centred on the outer one and scaled from it.
3. **The radial dividers**, clockwise from 12 o'clock: one `line` Live Shape each, from the centre to the outer ellipse.

Counts of 0 leave only the outer ellipse. Create Compound Path From Ellipses, off by default, is out of scope for #151, so the ellipses stay separate Nodes.

## The Polar Grid's geometry

The outer ellipse is `dragBox`'s box, with Shift for a circle, Alt from the centre and Space to move. Its centre is `(cx, cy)` and its radii `rx, ry`. A drag flat as a line draws nothing.

- **Concentric.** `n` concentric dividers split the radius into `n + 1` rings, spaced as the Rectangular Grid's dividers: divider `i` has radii `f_i·rx, f_i·ry`. Positive skew packs the rings toward the outer ellipse, following the In…Out ends of the Concentric Skew slider.
- **Radial.** `n` radial dividers cut the turn into `n` sectors, not `n + 1`: a full turn has no second end. The first line points to 12 o'clock. The sectors follow the same geometric rule, so line `j`, from 0 to `n − 1`, lies at the turn fraction `t_0 = 0` and `t_j = f_j` for `n − 1` dividers otherwise, evenly `j / n` at 0%. Positive skew packs the lines clockwise, toward the end of the turn. Its end is the point of the outer ellipse at the parametric angle `2π·t`: `(cx + rx·sin 2πt, cy − ry·cos 2πt)`. On an ellipse, the lines stay where a circle's grid, scaled to the box, puts them.

**Ceiling.** Adobe does not publish the skew formula. This one keeps what the Options dialog describes: 0% is even, and the sign picks the side the dividers weight toward. It is not matched against a live Illustrator, so a grid of the same counts and skew can space its dividers differently there. For the Polar Grid, Illustrator's starting direction for the radial lines, and whether its skew or 12 o'clock are measured clockwise, are also unverified: these are Kalamo's choices.

## The keys and defaults

During the drag, from Illustrator's keyboard shortcuts for drawing:

| Key | Change |
|---|---|
| Up, Down | add or remove a horizontal divider |
| Right, Left | add or remove a vertical divider |
| V, F | raise or lower the horizontal skew by 10% |
| C, X | raise or lower the vertical skew by 10% |

The Polar Grid tool's keys differ, as Illustrator's do:

| Key | Change |
|---|---|
| Up, Down | add or remove a concentric divider |
| Right, Left | add or remove a radial divider |
| C, X | raise or lower the concentric skew by 10% |
| V, F | raise or lower the radial skew by 10% |

Counts run from 0 to 999 and skews from −500% to 500%. These are Kalamo's bounds, not checked against Illustrator's Options fields: 999 keeps a grid under 2,000 Nodes, and at 500% each cell is 1/32 of the one before it. The tool takes these keys while the pointer is down (#143), so they switch no tool and change no Fill and Stroke box. Both tools share these bounds. A session starts each tool at 5 and 5 dividers (horizontal and vertical, or concentric and radial) at 0% skew, the defaults Illustrator's Options dialog is described with, unverified in the research ([?]). The counts and skews a drag ends with carry over to that tool's next drag.

## The paint

Illustrator's Fill Grid is off by default: every child takes the current Stroke and no Fill, the frame and the outer ellipse included, whatever the Fill box holds. With a None Stroke the children are still drawn, unpainted, as the Line Segment tool's line is. The Group has no Appearance of its own.

## Considered Options

- **A Live grid**, one Node with counts and skews. Illustrator has none, and Inkscape would receive it as a Group, so it could not round-trip; it is out of scope for #150.
- **Open Paths for the dividers.** Each is a single straight segment, which a Live Line keeps exactly, with its ends editable in the Properties panel and a plain `<line>` on export.
- **`n + 1` radial sectors,** as the Rectangular Grid's cells. A turn has one seam, not two sides, so `n + 1` sectors would need `n + 1` lines; Illustrator users split a circle into 12 slices with 12 radial dividers.
- **Radial lines at geometric angles on an ellipse,** each at its true angle from the centre. That bunches them toward the long axis; the parametric angle keeps a squashed grid a scaled circular one.
- **Linear skew,** each cell a fixed step larger than the one before. Past some skew the smallest cell reaches 0 and the dividers cross; a geometric ratio stays positive at any skew and mirrors under `−s`.

## Consequences

- F-DRAW-01 now says both grids draw a Group of Live Shapes.
- Drawn art whose `create` holds a Group selects the Group, not its inline children, and so does any other pending create with inline children.
- The Polar Grid tool reuses the Group, the paint rule, the bounds and the carry-over.
- Out of scope for #150 and #151: both Tool Options dialogs, including Fill Grid, turning off Use Outside Rectangle As Frame, and Create Compound Path From Ellipses.
