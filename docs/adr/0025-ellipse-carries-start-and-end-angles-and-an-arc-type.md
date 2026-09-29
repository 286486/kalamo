---
status: accepted
date: 2026-09-25
---

# The ellipse carries start and end angles and an arc type

ADR-0017 lists an ellipse's start and end angles with slice, chord and open arc types as a Kalamo gap: until they exist, Inkscape's `sodipodi:type="arc"` imports as a Path with `ARC_AS_PATH` (#35, F-DRAW-03). This ADR adds them.

## The parameters

| Field | Default | Range | Inkscape | Meaning |
|---|---|---|---|---|
| `startAngle` | 0 | 0 ≤ a < 360 | `sodipodi:start = startAngle·π/180` | where the outline starts, degrees clockwise on screen from 3 o'clock |
| `endAngle` | 360 | 0 < a ≤ 360 | `sodipodi:end = endAngle·π/180` | where it ends, likewise |
| `arcType` | `slice` | `slice`, `chord`, `open` | `sodipodi:arc-type` `slice`, `chord`, `arc` | how the ends close: through the centre, straight across, or not at all |

The names and the 0°/360° defaults are Illustrator's Pie Start Angle and Pie End Angle. Illustrator has only the pie, so the arc type takes its values from Inkscape and F-DRAW-03, with Inkscape's `arc` named `open`, which says what it draws. The direction is clockwise on screen, as `rotate` and a star's `angle` are (ADR-0024), where Illustrator's pie angles run counterclockwise.

An angle is **parametric**, as Inkscape's are: the point at angle `t` is `(cx + rx·cos t, cy + ry·sin t)`, the point at `t` on the circle the ellipse is stretched from. On a circle it is the polar angle. On any other ellipse it differs from the polar angle, but it survives a change of `width` or `height`: the pie keeps its share of the outline when the ellipse is stretched.

The ranges make each outline one pair of numbers. 0° and 360° are the same direction, so a start of 360° is written 0° and an end of 0° is written 360°. Import normalises Inkscape's radians the same way, so a file's angle comes back as the number Kalamo wrote.

## The geometry

The outline runs clockwise from `startAngle` to `endAngle`, through a sweep of `(endAngle − startAngle) mod 360`, as Inkscape 1.2.2 draws it: an end before the start wraps through 0°. The arc is cubics of at most 90° each, as `A` in a `d` already becomes (`core/path.ts`).

- `slice`: `M` at the start point, the arc, `L` to the centre, `Z`.
- `chord`: `M` at the start point, the arc, `Z`.
- `open`: `M` at the start point and the arc, unclosed. Its Fill is drawn as if closed, as SVG and Canvas2D fill any open subpath.

A sweep of 0 (the defaults, or equal angles) is the whole ellipse, closed, whatever the arc type, as Kalamo drew it before this ADR. Inkscape draws a whole open arc unclosed, which only changes the line join at one point.

`shapeSegments` draws them, so the canvas, `render` and export draw the same outline, and `node_get` returns it as `d`. `node_create` and `node_update` accept the three fields. `node_transform` composes into `transform` (ADR-0007) and leaves them alone.

## SVG

**Export.** An ellipse with the default angles and arc type is `<circle>` or `<ellipse>`, as before. Any other is `<path sodipodi:type="arc">` with `sodipodi:cx`, `cy`, `rx` and `ry` at export precision, `sodipodi:start` and `sodipodi:end` in radians at full precision, `sodipodi:arc-type`, `sodipodi:open="true"` for `chord` and `open`, which Inkscape's own writer adds for older readers, and a `d` from `shapeSegments`. A whole ellipse with non-default parameters is written as an arc too, so nothing is lost: Inkscape draws it whole.

A plain save in Inkscape keeps these attributes verbatim and rebuilds only the display. When the designer edits the arc, Inkscape rewrites them: the angles normalised to 0…2π at about 8 significant digits, and a whole ellipse as `<ellipse>`, which drops its angles and arc type. Import's 3-decimal rounding absorbs the digits.

**Import.** A `<path sodipodi:type="arc">` is an ellipse: `x = cx − rx`, `y = cy − ry`, `width = 2rx`, `height = 2ry`, baked and rounded as any ellipse (ADR-0017). `sodipodi:start` and `sodipodi:end` become degrees modulo 360, rounded to 3 decimals, a start of 360 read as 0 and an end of 0 as 360. A missing angle is 0, as Inkscape reads it. `sodipodi:arc-type` `chord` and `arc` are `chord` and `open`, any other value is `slice`; with no `arc-type`, `sodipodi:open="true"` is `open` and anything else `slice`, as Inkscape 1.2.2 reads them. The `d` is ignored, since Inkscape draws from the parameters too.

`ARC_AS_PATH` now covers only an arc whose parameters Kalamo cannot hold, a non-finite value or a negative radius: it imports as the Path its `d` draws.

## Considered Options

- **Polar angles.** Closer to how a person reads an angle on a squashed ellipse, but Inkscape stores parametric ones, so every imported arc would need converting and the conversion would drift at 3 decimals. A stretched pie would also change its share of the outline.
- **Any angle, normalised when drawn.** Friendlier to an Agent that sends −90°, but 270° and −90° would draw the same pie and not survive the round trip as the same number.
- **Illustrator's counterclockwise direction.** Every other angle in the model runs clockwise on screen.
- **Export a whole ellipse as `<ellipse>` whatever its parameters.** Simpler, but a whole chord ellipse, or one with equal non-zero angles, would come back as a default ellipse.

## Consequences

- Schema: the ellipse gains `startAngle`, `endAngle` and `arcType`. Existing Documents read them as the defaults, which draw what they drew: a `.kalamo.json` through the schema defaults, a Node already stored where it is drawn and exported, without rewriting storage.
- ADR-0017's ellipse row is amended: a partial ellipse, or one with a non-default arc type, is a `<path sodipodi:type="arc">`.
