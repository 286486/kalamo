---
status: accepted
date: 2026-09-29
---

# The Arc tool draws a Path

REQUIREMENTS F-DRAW-01 lists Arc among the shape tools and says they all make Live Shapes. Illustrator's Arc tool does not: its arc is a plain path of two anchors, and the Arc Segment Tool Options only set up the next drag. This ADR records how Zibel's Arc tool (#147) draws, and amends F-DRAW-01 for Arc.

## Why a Path

- **Illustrator makes a path.** Once drawn, an Illustrator arc has no slope or base axis left to edit. Its only live state is the tool's options, which carry over to the next drag.
- **Nothing round-trips the parameters.** No Inkscape object keeps a slope or a base axis, so a Live Arc would export as a plain `<path>` and come back as one, against ADR-0017's lossless round trip.
- **Not an ellipse with `arcType: "open"`.** ADR-0025's open ellipse is the one Live Shape that is an arc, but it is always elliptical. Illustrator's slope bends one cubic between the two ends. That cubic is close to an elliptical quarter at one slope only, so an ellipse arc cannot hold slope −100…100 or the concave/convex switch.

The tool sends a `path` with a `d` through the shared pending create, as the Pen does.

## The geometry

The drag gives the arc's two ends. `A` is the reference point, the press, and `B` is the pointer. Length X and Length Y are `|B.x − A.x|` and `|B.y − A.y|`. Shift makes them equal, as big as the longer one, in the drag's direction, as the Rectangle tool's square. Alt makes the press the centre, so `A = press − (B − press)`. Space moves the arc, and sizing resumes from the moved press.

The base axis picks the corner `O` the arc bends around, one of the two other corners of the box `A`–`B`:

- X Axis: `O = (B.x, A.y)`. The arc's base, `A`–`O`, lies along X.
- Y Axis: `O = (A.x, B.y)`. The base lies along Y.

`Q = A + B − O` is the box's fourth corner. The slope `s`, from −100 to 100, sets one cubic `M A C c1 c2 B`:

- `t = |s| / 100`, and the target is `Q` when `s > 0` (convex, bulging away from `O`) or `O` when `s < 0` (concave, bulging toward it).
- `c1 = A + t·(target − A)` and `c2 = B + t·(target − B)`.

So slope 0 is the straight line, with both handles on their anchors, and ±100 pulls both handles to the corner, the furthest one cubic bends that way: Adobe's "fully" convex or concave. Its midpoint still stops a quarter of the way short of the corner. Slope 50 comes within about 3% of the box of the quarter ellipse centred on `O`, whose handles would sit at `t ≈ 0.552`.

A closed arc adds the two straight segments through `O`: `M A C c1 c2 B L O Z`. A convex one is a quarter-pie, a concave one a corner fillet.

A drag with zero width or zero height has `O`, `Q` and both handles on the line `A`–`B`, so it draws that line, as Illustrator's does. A drag back to its press draws nothing.

## Keys during the drag

Through the tool key routing (#143), none of them switches tools:

- **Up and Down** step the slope by 1, within −100…100.
- **C** switches between open and closed.
- **F** flips the arc and keeps the reference point. With both ends held by the press and the pointer, the only flip is to bend around the box's other corner, which is switching the base axis.
- **X** switches concave and convex: it negates the slope.

## Defaults, carry-over and paint

The first drag in a session is Open, X Axis, slope 50. Adobe's help does not state them, so they are unconfirmed [?]; they are the defaults tutorials show in the dialog. The type, base axis and slope a drag ends with carry over to the next drag in the session, as Illustrator's options do. They are not stored anywhere else.

Illustrator's Fill Arc is off by default. An open arc takes the current Stroke and no Fill, as the Line Segment tool does. A closed arc takes the current Fill and Stroke.

## Ceiling

Adobe does not publish the formula, and no public Illustrator SVG of an arc at known options was found. The linear `t = |s|/100`, the corner each base axis picks, and the step of 1 per arrow press are derived from Adobe's help (slope 0 is straight, negative is concave, positive convex) and are **not matched against a live Illustrator**. Upgrade path: draw arcs at slopes −100, −50, 0, 50, 100 on both base axes in Illustrator, save as SVG, and fit `t(s)` and the corner to those `d`s; only `dragArc` changes.

## Considered Options

- **A Live Arc** with slope, axis and type. Illustrator has none, and no file format would keep it (see above).
- **An ellipse with `arcType: "open"`.** Cannot hold a slope other than one, or the concave side.
- **F as a mirror across the chord.** On a box that is not square the mirror of the cubic no longer spans the same box, so the ends would leave the press or the pointer.

## Consequences

- REQUIREMENTS F-DRAW-01 says Arc makes a Path; CONTEXT.md's Live Shape entry says the same.
- The web app's drawn art gains `PathArt`, the `{ type: "path", d }` the Pen already sent. The shape tools' `unfilled` becomes a predicate of the tool's options, so a closed arc is filled and an open one is not.
- No change to core, the Document schema, the sync protocol, MCP, `render`, SVG or `.zibel.json`: an arc is an ordinary Path everywhere.
