---
status: accepted
date: 2026-09-30
---

# Inserted midpoint stops are dropped only while they lie on the curve

ADR-0081 draws a Midpoint in SVG with extra stops marked `kalamo:simulated="true"`, and import drops every marked stop. Inkscape 1.2.2 adds a stop by duplicating the stop before it, attributes and all (`sp_vector_add_stop`, `sp_gradient_add_stop`). A stop the designer adds after an inserted stop is therefore marked too, and import dropped it with no warning, even after the designer recoloured it (#204). This ADR amends ADR-0081's import rule, its Inkscape section and its option "Recognising inserted stops by colour instead of marks".

## The rule

Import judges the marked stops span by span. A span runs from one unmarked stop to the next unmarked stop.

- **On the curve.** Each marked stop in the span is compared with the colour the span's curve gives at its own offset: core's `colorAt` over the span's two unmarked stops, with the start stop's midpoint. That midpoint is its `kalamo:midpoint` clamped to 0.13–0.87, or 0.5 when it has none. If every channel and the alpha of every marked stop lie within **2 steps** on the 0–255 scale, import drops them all and keeps the midpoint.
  - Export lands within 1 step of the curve (ADR-0081's tolerance), and Inkscape rewrites alpha as `stop-opacity`, so 2 steps leaves room for one more rounding.
  - The offsets are compared before they are rounded to 3 decimals, since the curve is steep next to its stop.
- **Off the curve.** If any marked stop in the span is further off, the span is kept as SVG draws it: every stop in it becomes an ordinary Color Stop, and the start stop drops its midpoint, since the kept stops already draw it.
- **Outside the unmarked stops.** A marked stop before the first unmarked stop or after the last one is kept the same way, so the pad colours are not lost.
- **The warning.** When any marked stop is kept, import warns `MIDPOINT_STOP_KEPT` once per gradient element that holds the stops: "Stops Kalamo inserted to draw a midpoint were kept as Color Stops, since the gradient was edited."
- **Midpoints.** Only an unmarked stop followed by an unmarked stop keeps its midpoint. So the last stop drops it, as before, and so does a stop followed by a kept marked stop.
- **Unmarked copies.** An unmarked stop copied from a real stop with a midpoint (Inkscape copies `kalamo:midpoint` too) is an ordinary stop with that midpoint, clamped. The marked stops after it are judged against its own curve.
- **Unchanged.** Clamping to 0.13–0.87, 0.5 not stored, a file without marks imports every stop as an ordinary Color Stop, and reflect or repeat unrolling drops midpoints.

`unmark` in `io`'s `gradient.ts` does this, beside `unroll`. Core gains `colorSteps`, the largest channel difference of two colours; the curve is core's `colorAt`, not a second one.

## What Inkscape edits come to

`fixtures/midpoint-edits.ts` makes each edit on a Kalamo export, black to white at 0.25, the way Inkscape makes it, since Inkscape 1.2.2's command line has no action that adds or recolours a stop. `io` checks the stops read back. `render` checks that they draw what resvg draws of the edited file within the round trip's vector budget, 0.7 % of the pixels (ADR-0017). `pnpm roundtrip` saves each edited file in Inkscape and checks two things: Open reads the saved file as it reads the edited one, warnings included, and Kalamo draws it within that budget of Inkscape's drawing.

| Edit in Inkscape | Import |
|---|---|
| A plain save | the original stops, no warning |
| A stop added between inserted stops, in the colour Inkscape gives it there | the original stops, no warning |
| An inserted stop recoloured 2 steps off its curve, in one channel or the alpha | the original stops, no warning |
| An inserted stop recoloured 3 steps off its curve, in one channel or the alpha | the span as drawn, warning |
| A stop added after an inserted stop and recoloured (#204's repro) | the span as drawn, the new stop included, warning |
| An inserted stop moved | the span as drawn, warning |
| A marked stop copied before the first stop or after the last | kept, the span between as its midpoint, warning |
| A real stop recoloured by a step | the midpoint kept, the new colour taken |
| A real stop recoloured | the span as drawn, warning |
| A stop added after a real stop with a midpoint, which Inkscape puts within 0.001 of it | an ordinary stop at that stop's offset with the copied midpoint, which judges the span after it |
| That stop then moved along the gradient | the span as drawn, warning |

## Considered Options

- **Drop every marked stop (ADR-0081).** A stop the designer added is lost silently, and the pixels change.
- **Recognise inserted stops by colour alone, without marks.** Every stop of an unmarked file that happens to lie on some power curve would become a midpoint, which a file from Illustrator or Inkscape never meant.
- **Judge each marked stop on its own.** Dropping the stops on the curve and keeping the rest would draw a midpoint's curve and straight blends mixed in one span, matching neither Kalamo nor Inkscape.
- **Another tolerance.** 1 step would take Inkscape's rounding of an inserted stop's alpha into `stop-opacity` as an edit. A wider one would drop a stop the designer changed by a few steps.

## Consequences

- Recolouring a real stop in Inkscape by more than 2 steps turns its span's inserted stops into real Color Stops. The pixels are kept, but the Gradient panel shows a dozen stops and no midpoint. Illustrator's panel would too for the same SVG, since it holds no midpoint either.
- Inkscape puts a stop added right after a real stop with a midpoint halfway to the first inserted stop, within 0.001 of the real stop. It reads back at the real stop's offset, so the span between them is empty and the copy's own curve draws the rest. Moved further along, the inserted stops lie on neither curve, and the span imports as drawn, with the warning.
- The import warning codes gain `MIDPOINT_STOP_KEPT`. `kalamo_doc_open` and `kalamo_svg_import` name it, and ADR-0017's warning list does.
- CONTEXT.md's **Midpoint** entry gives the new rule.
