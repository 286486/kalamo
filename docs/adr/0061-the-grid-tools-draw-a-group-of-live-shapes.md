---
status: accepted
date: 2026-09-29
---

# The grid tools draw a Group of Live Shapes

REQUIREMENTS F-DRAW-01 lists Rectangular Grid and Polar Grid among the shape tools and says every one but Arc makes a Live Shape. Neither grid does in Illustrator. This ADR records what Zibel's Rectangular Grid tool (#150) draws, and amends F-DRAW-01 for both grids. The Polar Grid tool (#151) amends it with its own children and spacing.

## Why a Group

- **Illustrator makes a Group.** A drag with Illustrator's Rectangular Grid tool leaves a Group of plain paths: an outer rectangle and one path per divider. Once drawn, it has no divider count or skew left to edit. The Rectangular Grid Tool Options only set up the next drag, like the Arc tool's (ADR-0059).
- **Nothing round-trips a grid.** Inkscape has no grid object, so a Live grid would export as a Group of plain elements and come back as one, against ADR-0017's lossless round trip.

The tool sends one `create` (ADR-0032) of a `group` whose inline children are the frame and the dividers, through the shared pending create (#141). The Group, not its children, becomes the Selection: a `tx` that answers drawn art selects each created Node whose parent it did not also create.

## The children

In stacking order, bottom to top:

1. **The frame**, a `rect` Live Shape spanning the drag: Illustrator's Use Outside Rectangle As Frame, on by default.
2. **The horizontal dividers**, from the top down, then **the vertical dividers**, from the left: one `line` Live Shape each, from one side of the frame to the other.

A divider is a `line` Node, not an open Path: it is one straight segment, which is exactly a Live Line, and it exports as `<line>`. A count of 0 leaves only the frame.

## The geometry

The frame is `dragBox`'s box: Shift makes it a square, Alt centres it on the press, and Space moves it, as with the Rectangle tool. A drag flat as a line, or back to a point, draws nothing.

`n` dividers split a side into `n + 1` cells. Skew `s`, in percent, makes each cell `q = 2^(−s/100)` times the one before it, so the cells shrink or grow geometrically toward one side. Divider `i`, from 1 to `n`, lies at the fraction

- `f_i = i / (n + 1)` when `s = 0`, evenly spaced;
- `f_i = (1 − q^i) / (1 − q^(n+1))` otherwise.

Positive skew packs the dividers toward the high end, `f` near 1, and `−s` mirrors `s` exactly: `f_i(−s) = 1 − f_(n+1−i)(s)`. At 100% each cell is half the one before it. Following the ends of Illustrator's Skew sliders, Bottom…Top and Left…Right:

- a horizontal divider lies at `y = bottom − f·height`, so positive skew packs them toward the top;
- a vertical divider lies at `x = left + f·width`, so positive skew packs them toward the right.

**Ceiling.** Adobe does not publish the skew formula. This one keeps what the Options dialog describes: 0% is even, and the sign picks the side the dividers weight toward. It is not matched against a live Illustrator, so a grid of the same counts and skew can space its dividers differently there.

## The keys and defaults

During the drag, from Illustrator's keyboard shortcuts for drawing:

| Key | Change |
|---|---|
| Up, Down | add or remove a horizontal divider |
| Right, Left | add or remove a vertical divider |
| V, F | raise or lower the horizontal skew by 10% |
| C, X | raise or lower the vertical skew by 10% |

Counts run from 0 to 999 and skews from −500% to 500%. These are Zibel's bounds, not checked against Illustrator's Options fields: 999 keeps a grid under 2,000 Nodes, and at 500% each cell is 1/32 of the one before it. The tool takes these keys while the pointer is down (#143), so they switch no tool and change no Fill and Stroke box. A session starts at 5 horizontal and 5 vertical dividers at 0% skew, the defaults Illustrator's Options dialog is described with, unverified in the research ([?]). The counts and skews a drag ends with carry over to the next one.

## The paint

Illustrator's Fill Grid is off by default: every child takes the current Stroke and no Fill, the frame included, whatever the Fill box holds. With a None Stroke the children are still drawn, unpainted, as the Line Segment tool's line is. The Group has no Appearance of its own.

## Considered Options

- **A Live grid**, one Node with counts and skews. Illustrator has none, and Inkscape would receive it as a Group, so it could not round-trip; it is out of scope for #150.
- **Open Paths for the dividers.** Each is a single straight segment, which a Live Line keeps exactly, with its ends editable in the Properties panel and a plain `<line>` on export.
- **Linear skew,** each cell a fixed step larger than the one before. Past some skew the smallest cell reaches 0 and the dividers cross; a geometric ratio stays positive at any skew and mirrors under `−s`.

## Consequences

- F-DRAW-01 now says both grids draw a Group of Live Shapes.
- Drawn art whose `create` holds a Group selects the Group, not its inline children, and so does any other pending create with inline children.
- The Polar Grid tool reuses the Group, the paint rule and the carry-over, and amends this ADR with its ellipse and radial-line children and their skews.
- Out of scope for #150: the Rectangular Grid Tool Options dialog, including Fill Grid and turning off Use Outside Rectangle As Frame.
