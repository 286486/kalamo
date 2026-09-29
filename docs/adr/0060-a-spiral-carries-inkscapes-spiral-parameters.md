---
status: accepted
date: 2026-09-29
---

# A spiral carries Inkscape's spiral parameters

REQUIREMENTS F-DRAW-01 lists Spiral among the Live Shapes and asks that its parameters cover Inkscape's spiral, so an Inkscape round trip loses nothing. ADR-0017 lists "Inkscape's spiral parameters when the spiral Live Shape arrives" as a gap: until now a `sodipodi:type="spiral"` imported as a Path. This ADR adds the `spiral` Live Shape (#148). The Spiral tool (#149) draws it.

## The parameters

| Field | Default | Range | Inkscape | Meaning |
|---|---|---|---|---|
| `cx`, `cy` | | any | `sodipodi:cx`, `cy` | the centre |
| `radius` | | ≥ 0 | `sodipodi:radius` | centre to the outer end |
| `revolution` | 3 | 0.05…1024 | `sodipodi:revolution` | turns from the centre (t = 0) to the outer end |
| `expansion` | 1 | 0…1000 | `sodipodi:expansion` | how the turns spread: 1 evenly, above 1 wider outward, below 1 wider inward, 0 a circle |
| `argument` | 0 | any | `sodipodi:argument = argument·π/180` | the direction at t = 0, degrees clockwise on screen from 3 o'clock |
| `t0` | 0 | 0…0.999 | `sodipodi:t0` | where the inner end starts, as a share of t |

The curve is `r = radius·t^expansion` at `θ = 2π·revolution·t + argument`, for `t` from `t0` to 1: the point `(cx + r·cos θ, cy + r·sin θ)`. The ranges are the ones Inkscape 1.2.2 clamps to when it reads a file, found by drawing a `revolution` of 0.01, which it draws as 0.05. A value Inkscape would clamp is rejected, so `node_get` shows what is drawn. `argument` is in degrees, as every other angle in the model is (`rotate`, a star's `angle`, an ellipse's `startAngle`); every other name is Inkscape's.

**Direction.** With `y` down, `θ` growing is clockwise on screen, so a spiral always turns clockwise from its centre outward. That is all Inkscape stores. A counterclockwise spiral is the same spiral mirrored, and the mirror lives in `transform`, as Inkscape keeps it: checked in 1.2.2, `object-flip-horizontal` on a spiral writes `transform="matrix(-1,0,0,1,…)"` and leaves the parameters alone. `node_transform` composes a flip into `transform` (ADR-0007), and import keeps a flip unbaked (ADR-0017), so a mirrored spiral round-trips as one.

**Why Inkscape's model, not Illustrator's.** Illustrator's Spiral tool has Radius, Decay, Segments and Style, and what it draws is a plain path, not a live object: its options only set up the next drag, like the Arc tool's (ADR-0059). Its curve is a different one, each quarter-wind segment's radius the one before it times Decay, a geometric decay. `r = radius·t^expansion` is a power of `t`, so no choice of Inkscape's parameters draws Illustrator's curve, and an Illustrator spiral stored as its Decay and Segments would reach Inkscape as a Path. The requirement is a lossless Inkscape round trip, so the model is Inkscape's, and the tool maps Illustrator's controls onto it (below).

## The geometry

`shapeSegments` in `core/spiral.ts` draws the spiral as Inkscape 1.2.2 does, so the canvas, `render`, export and `node_get`'s `d` are the same outline. It was derived from Inkscape's output: 700 random spirals (centres within ±500, radii 0.5…3000, `revolution` 0.05…200, `expansion` 0.001…60, any `argument`, `t0` 0 or random), rebuilt by `inkscape --actions="select-all;object-to-path"` and compared command by command.

- **Parameters** are read as float32 (`Math.fround`) and computed in double, as Inkscape holds them: a centre of 355.403 draws from 355.40302.
- **Pieces.** From `t = t0`, each piece covers `0.25 / revolution` of `t`, a quarter turn, while `t < 1 − 0.25/revolution`; then one last piece to 1 if more than 10⁻⁵ of `t` is left. The 10⁻⁵ was bracketed at 0.99·10⁻⁵ (left undrawn) and 1.01·10⁻⁵ (drawn); without it a spiral with round-number parameters gains a piece of zero length.
- **Samples.** A piece takes 8 samples, `dstep` = its length / 7 apart. A sample exactly equal to the one before it (the centre, where `radius·t^expansion` is below a unit's float precision) is skipped as long as `t < 1`, and the step after the skip is doubled. The next piece starts at the last `t` stepped to, less `2·dstep`, which is the 8th sample when nothing was skipped.
- **Tangents.** The unit tangent at `t` is `(expansion, 2π·revolution·t)` turned by `θ`; `(cos θ, sin θ)` at `t = 0`; `(−sin θ, cos θ)` when `expansion` is 0. A piece leaves along the tangent at its start and arrives along the tangent at its end, the one it passes to the next piece.
- **Fit.** Each piece is Schneider's least-squares cubic ("An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems 1990) through its 8 samples with the end tangents fixed and a tolerance of 3 units: chord-length parameters, one Newton step on each inner sample's parameter, then the error. A step that would put the sample farther from the curve is not taken. When the worst sample is within 3 tolerances but more than one, up to 4 more fits, each followed by a Newton step. A handle solved shorter than 10⁻⁶, or pointing backwards, is replaced by a third of the chord for both. A piece that still misses splits at its worst sample, with the tangent there from the sample before to the one after, into at most 5 cubics; one that cannot fit in 5 draws lines through its samples. A piece whose samples are all one point draws nothing, so a `radius` of 0 is its `M` alone.
- **Open.** No `Z`. The Fill paints as an open path's does, closed by the straight line from the outer end back to the inner one, in Zibel and in Inkscape alike.

**Measured error.** 698 of the 700 match Inkscape's coordinates to 0.01 units, or to 10⁻⁶ of the coordinate where it exceeds 10⁴ (Inkscape writes 8 significant digits). Of the other two, one (`radius` 1259, `expansion` 4.07) has its innermost cubic's handles 4.6 units off, 0.45 units from Inkscape's curve at worst. The other (`expansion` 54) samples past `t = 1` after skipping repeats at its centre, as Inkscape does, and its last points lie beyond 10¹¹ units, where the two differ. `core/spiral.test.ts` checks 37 of them against the `d` Inkscape wrote (`spiral.inkscape.json`). In `pnpm roundtrip`, the fixture's Spirals Artboard (a plain, a filled and a mirrored spiral) differs from Inkscape's rendering of the reopened file by 0.22% of its pixels, against the vector budget of 0.7%.

The fit is Schneider's published algorithm, with its thresholds, split limit and sampling found by comparing against Inkscape's output (ADR-0017: no Inkscape source is ported). Its own `fitInk` (ADR-0033) differs in its fallback and split rules, so the spiral has its own copy of the few lines they share.

## MCP

`node_create` and `node_update` take `{type: "spiral", cx, cy, radius, revolution?, expansion?, argument?, t0?}`, parsed strictly (ADR-0050): an unknown key, or a value outside its range, is `INVALID_INPUT` naming the field and its range. `node_get` returns the parameters and the derived `d`. `node_transform` composes into `transform` (ADR-0007) and leaves the parameters alone. Anchor-level editing converts a spiral to a Path, as every Live Shape.

## SVG

**Export** writes `<path sodipodi:type="spiral">` with `sodipodi:cx`, `cy`, `radius`, `revolution`, `expansion`, `argument` (radians) and `t0` at full precision, as a star's are (ADR-0024), and a `d` from `shapeSegments` at export precision. Inkscape rebuilds the outline from the parameters on load.

**Import** reads a `sodipodi:type="spiral"` as a spiral. A missing attribute takes Inkscape's default: `cx`, `cy` and `argument` 0, `radius` 1, `revolution` 3, `expansion` 1, `t0` 0, checked by drawing a bare `sodipodi:type="spiral"` in 1.2.2. A matrix that is a move plus a uniform scale bakes into `cx`, `cy` and `radius`, which round to 3 decimals (ADR-0017); any other matrix, a flip or a turn among them, stays in `transform`. `revolution`, `expansion` and `t0` are kept as written, since they carry no float error to absorb and 3 decimals of `t0` would move the inner end; `argument` rounds to 9 decimals of a degree, as a star's `angle` does (ADR-0024). The `d` is ignored.

A spiral whose parameters Zibel cannot hold (a non-finite number, a negative `radius`, or a `revolution`, `expansion` or `t0` outside the ranges above, which Inkscape would clamp) imports as the Path its `d` draws, with a `SPIRAL_AS_PATH` warning. That is what Inkscape draws, since it draws the clamped value.

## The Spiral tool's controls

Illustrator's Spiral tool is dragged from the centre, with Radius, Decay (the factor from one segment's radius to the next) and Segments (four per wind), and a Style of clockwise or counterclockwise. The tool (#149) keeps them as its own session state, as the Arc tool keeps its options (ADR-0059), and writes Inkscape's parameters:

- `cx`, `cy` is the press. `radius` is the distance to the pointer.
- **Segments → `revolution` = segments / 4**, with `t0` = 0. Up and Down step one segment, 0.25 of `revolution`, down to 1 segment (0.25). Alt-drag adds or removes segments as the pointer moves out or in.
- **Decay → `expansion` = ln(decay) / ln(0.8)**, so Illustrator's default 80% is Inkscape's default 1, a decay nearer 100% spreads the turns less and approaches 0, a circle, and a smaller one spreads them more. A decay of 100% or more, which in Illustrator keeps or grows the radius inward, is 0, the smallest `expansion`. Ctrl/Cmd-drag changes the decay.
- **Rotation.** The outer end points at the pointer: `argument` = the pointer's angle − 360·`revolution`, so rotating the drag turns the spiral, and Shift snaps the pointer's angle to 45°.
- The session starts at Illustrator's 10 segments (`revolution` 2.5) and 80% decay (`expansion` 1).
- Style is not a tool option in #149. A counterclockwise spiral is a clockwise one with a mirror in `transform` (above), which Reflect makes.

The two curves differ: Illustrator's radius falls by a constant factor per quarter turn, a power of `t` does not, and Illustrator's spiral stops short of the centre, at the last segment, where this one with `t0` = 0 runs into it. The mapping keeps what the drag shows, the number of turns, the outer radius and end, and which way the decay goes; it does not reproduce Illustrator's curve.

## Considered Options

- **Illustrator's Decay and Segments as the model**, drawn as Illustrator draws them. Inkscape has no such object, so every spiral would reach Inkscape as a Path and could not be edited there as a spiral, against F-DRAW-01's lossless round trip.
- **Both models,** an Inkscape spiral and an Illustrator one. Twice the surface for a shape the requirement names once; an Illustrator spiral would still not round-trip.
- **`argument` in radians**, as Inkscape writes it. Every other angle an Agent sends is degrees.
- **A `clockwise` flag.** Inkscape stores no direction, so the flag would have to become a mirror in `transform` on export and could not be told from a flipped spiral on import.
- **Fit Illustrator's curve with `t0`, `expansion` and `revolution`** (both ends and the turns exact). A power of `t` bends away from a geometric decay between the ends, by a factor of 1.2 in radius at `t0` = 0.5 for 10 segments at 80%, and it needs `revolution` up to 25 to show 2.5 turns. Inkscape's Turns field would then not show the turns drawn.

## Consequences

- Schema: a new Node type, `spiral`. Existing Documents have none.
- The Anchor, Direct Selection and Convert to Path code already works on `shapeSegments`, so it handles the spiral with no change.
- ADR-0017's gap list loses the spiral, its Live Shape table gains the spiral row, and `SPIRAL_AS_PATH` joins its warnings.
- CONTEXT.md's Live Shape entry lists the spiral and its parameters.
