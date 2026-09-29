---
status: accepted
date: 2026-09-25
---

# A gradient is inline in its Fill or Stroke, positioned in the Node's own coordinates

Linear and radial gradients (F-DOC-04, F-APP-04, #22) are one of the Kalamo gaps ADR-0017 lists: until they exist, an Inkscape gradient imports as a solid Fill or Stroke in its first stop's colour with `GRADIENT_FLATTENED`. This ADR adds them to Fills and Strokes, on every leaf that has an Appearance, text included.

## The model

A Fill or Stroke has a `type`: `solid` (the default) with a `color`, or `gradient` with a `gradient`. A Stroke keeps its width, cap, join, miter limit and dash either way. A Stroke stored before this ADR has no `type` and reads as `solid`.

```jsonc
{ "type": "gradient", "gradient": { "type": "linear", "stops": [{ "offset": 0, "color": "#1F5FBF" }, { "offset": 1, "color": "#9FD0FF00" }],
  "start": { "x": 0, "y": 50 }, "end": { "x": 200, "y": 50 } } }
{ "type": "gradient", "gradient": { "type": "radial", "stops": [ … ],
  "center": { "x": 100, "y": 50 }, "radius": 100, "aspectRatio": 0.5, "angle": 30, "focus": { "x": 120, "y": 50 } } }
```

| Field | Type | Meaning |
|---|---|---|
| `stops` | at least 2 Color Stops `{offset, color}` | `offset` 0–1 along the gradient; `color` is `#RRGGBB[AA]`, its alpha is the stop's opacity. Stored sorted by `offset`, stably, so equal offsets make a hard edge in the order given |
| `start`, `end` | points, linear only | the first stop sits at `start`, the last at `end`; they must differ |
| `center`, `radius` | point, number > 0, radial only | the ellipse the last stop sits on, before `aspectRatio` and `angle` |
| `aspectRatio` | number > 0, default 1 | the ellipse's radius across `angle` is `radius × aspectRatio` |
| `angle` | degrees, default 0 | the direction of `radius`, clockwise on screen from 3 o'clock, as every angle in the model is (ADR-0024) |
| `focus` | point, default `center` | where the first stop sits; kept inside the ellipse |

The names are Illustrator's: a gradient's stops are Color Stops, its type Linear or Radial, and a radial gradient has an aspect ratio, an angle and a focal point that the Gradient Annotator drags. `offset` is SVG's name for Illustrator's Location, 0–1 where Illustrator shows a percentage, as in F-DOC-04's example. Opacity is the colour's alpha, as for a solid Fill (ADR-0017), so a stop has no separate `opacity`.

**Positions are in the leaf's own coordinates**, the space its `d` or Live Shape parameters are in, before its `transform`. `node_transform` composes into `transform` (ADR-0007), so the gradient moves, turns and scales with the Node and nothing is rewritten. Editing a Live Shape parameter or a Path's `d` leaves the gradient where it is, as moving anchors does in Illustrator. This is also exactly SVG's `gradientUnits="userSpaceOnUse"` on the element, so export and import map it without conversion.

**Spread is pad.** Beyond the first and last stops the colour holds, as in Illustrator, SVG's default and Canvas2D's only mode.

**A Stroke's gradient is Illustrator's "apply gradient within stroke"**: the stroke's area is painted by the same field a Fill would be. Along and across the stroke (F-APP-04, P2) wait.

**Not in this ADR:** midpoints between Color Stops, which SVG and Inkscape cannot hold and only the Gradient panel edits (they join with it, as an optional per-stop field defaulting to halfway); Freeform gradients (F-APP-05, M4); gradient Swatches.

## Inline, not an Asset

F-DOC-04 allowed a `gradientId` into `assets.gradients[]` or an inline gradient. The gradient is inline, and there is no `gradientId`:

- **Geometry is per Fill anyway.** Two rectangles sharing a gradient still need their own start and end points, and Illustrator's gradient Swatch does not even keep an elliptical gradient's aspect ratio and angle, so a shared asset would hold only the type and stops.
- **Illustrator's link is weak.** A gradient Swatch cannot be edited in place; the only way art follows it is Replace Swatch (Alt-dragging a new gradient onto it), which repaints every object using it. That can be done by rewriting the Fills that came from the Swatch, without Fills pointing at it to be drawn.
- **One Node row stays self-contained.** `node_get`, the Delta Log (ADR-0017), `doc_changes` and Replace's per-Node merge each see a whole Fill, with no second table to keep in step, and deleting a Node can never orphan or dangle a gradient.

Gradient Swatches arrive with the Swatches panel (F-APP-02) as an Asset that applying copies from. If Replace Swatch is built, a Fill may then also carry the id of the Swatch it came from, as a tag Replace Swatch rewrites by; the inline gradient stays what is drawn.

## Writing a gradient

`node_create` and `node_update` accept the shape above, where `node_update`'s Merge Patch replaces the whole Fills or Strokes list as it does today. Geometry may be left out, and the write fills it in from the leaf's geometric bounds in its own coordinates, as they are after the write:

- **Linear:** `start` and `end` both or neither. With neither, an input-only `angle` (default 0) picks the direction, and the vector runs through the bounds' centre across the bounds' extent in that direction, so the first stop touches one side and the last the other: 0 is left to right, 90 top to bottom. `angle` is not stored.
- **Radial:** `center` defaults to the bounds' centre and `radius` to Illustrator's default, √((w² + h²) / 8), which is half the width on a square; `aspectRatio`, `angle` and `focus` as in the table.
- When the bounds have no extent in the direction needed (a vertical gradient on a horizontal line, or a point), the length is 1 pt.

What is stored, and what `node_get` returns, is always the full geometry, so an Agent reads back exactly where its gradient landed. A gradient whose `start` equals its `end`, or with `radius` or `aspectRatio` not greater than 0, fails validation with the field's `path`, because SVG paints those with the last stop's colour and Canvas2D paints nothing. A `focus` outside the ellipse is moved onto it, as SVG 1.1 does, so resvg, Inkscape and the canvas draw the same thing.

Gradients do not change bounds.

## Drawing

**SVG** (`toSvg`, so `render` and `export` alike). Each gradient paint is one self-contained `<linearGradient>` or `<radialGradient>` with its stops, in a `<defs>` just before its element, as Area Type's frame is (ADR-0022), and the paint is `fill="url(#…)"` or `stroke="url(#…)"`:

| Kalamo | SVG |
|---|---|
| gradient id | `fill-<i>-z-<ULID>` or `stroke-<i>-z-<ULID>`, `<i>` the paint's index in its list, beside `clip-z-` and `area-z-` |
| any gradient | `gradientUnits="userSpaceOnUse"`, no `spreadMethod` (pad is the default) |
| linear | `x1 y1 x2 y2` from `start` and `end` |
| radial | `cx cy r` from `center` and `radius`; `fx fy` from `focus`, left out when it is the centre, mapped back through the `gradientTransform` and then at its 6 decimals so it reads back to the same point; `gradientTransform` rotating by `angle` and scaling across it by `aspectRatio` about the centre, as a `matrix` at 6 decimals, left out when both are the defaults |
| Clipping Path | `none`: a `<clipPath>` cannot hold a `<defs>`, and its paint is never drawn (ADR-0021) |
| Color Stop | `<stop offset stop-color="#RRGGBB">`, plus `stop-opacity` at 3 decimals when the alpha is not FF, since Inkscape 1.2 draws `#RRGGBBAA` as black (ADR-0017) |

Inkscape 1.2.2 keeps such a gradient verbatim on a plain save, and when the designer moves the object it appends a `gradientTransform` to it in place (measured headless). When the designer edits the gradient, Inkscape splits it into a stops-only vector gradient and a positioned one that `xlink:href`s it. Import reads all three forms.

**Canvas.** `drawDocument` builds the same field with `createLinearGradient` and `createRadialGradient`. For a radial gradient with an `angle` or `aspectRatio`, it traces the outline, then applies the ellipse as a transform only for the `fill()` call, so the outline is not distorted. The same transform would also scale a Stroke's pen and a text's glyphs, so a Stroke or a text draws an elliptical radial gradient as its circle on the canvas until it can be drawn through an offscreen layer or glyph outlines; SVG, resvg and Inkscape draw it exactly. Text Fills and Strokes otherwise take the same styles.

## Import

- A `fill` or `stroke` of `url(#id)` naming a `<linearGradient>` or `<radialGradient>` becomes a gradient paint. The `href` / `xlink:href` chain resolves as SVG says: the stops come from the nearest gradient in the chain that has any, and each attribute (`x1`…, `cx`…, `gradientUnits`, `gradientTransform`, `spreadMethod`) from the nearest that sets it.
- **Units.** `objectBoundingBox`, SVG's default when `gradientUnits` is absent, is converted through the element's geometric bounding box in its user space. On a box with no width or height SVG ignores the gradient, so the fallback colour after `url()` is used, else no paint.
- **Transforms fold in exactly.** `gradientTransform` and the bounding-box mapping are applied to the geometry: a linear gradient under any affine map is still linear, with its end point recomputed so the stops keep their positions; a radial gradient under any affine map is an ellipse, found by decomposing the map, with the focus mapped by it. Then the leaf's own baking (ADR-0017) moves and scales the gradient with its parameters, so the gradient stays in the leaf's own coordinates.
- **Stops** follow SVG: offsets clamp to 0–1 and never decrease; `stop-color` is any CSS colour, `currentColor` included, and `stop-opacity` folds into its alpha.
- **Degenerate gradients** are drawn by SVG as solid colours, and import makes them solid: one stop is a solid paint of its colour, which is also how Inkscape stores a solid Swatch; `x1,y1` equal to `x2,y2`, or `r` of 0, is the last stop's colour; no stops is no paint.
- **`spreadMethod` reflect or repeat** is unrolled into stops: the gradient's extent grows until it covers the element's visible bounds, and the stops repeat or mirror over it, which draws the same pixels with pad.
- SVG 2's `fr` is ignored with `UNSUPPORTED_ATTRIBUTE` when it is not 0; Inkscape does not write it.
- `GRADIENT_FLATTENED` is retired. A `url()` to anything else, such as a `<pattern>` or Inkscape's `<meshgradient>`, is `UNSUPPORTED_PAINT` as before.

Replace (ADR-0017 step 2) needs nothing new: export rounds the positions to 3 decimals and the matrix to 6, and its normalising round trip reads them back to the same numbers.

## Files

**`.kalamo.json`** holds the gradient inside the Node's `appearance`, like any Fill; `version` stays 1, since a file without gradients is unchanged.

## Considered Options

- **`assets.gradients[]` with a `gradientId`** (F-DOC-04's other option, and REQUIREMENTS's example). Rejected above: the geometry is per Fill regardless, and Illustrator's only link, Replace Swatch, does not need Fills to reference the Swatch to be drawn.
- **Refit the default gradient when the geometry changes**, as Illustrator does for a gradient nobody has adjusted. It needs a stored "not adjusted" flag that an Agent cannot see the effect of; an Agent that resizes can send the Fill again without geometry.
- **Positions relative to the bounding box** (SVG's `objectBoundingBox`, 0–1). Friendlier for an Agent that wants "top to bottom", but the gradient would stretch when a parameter changed, which Illustrator does not do, a gradient on a horizontal line's Stroke has no box height to be relative to, and every Inkscape file (always `userSpaceOnUse`) would need converting. The input-only `angle` and the defaults give an Agent the friendly form without storing it.
- **Illustrator's origin, angle and length for linear.** Equivalent to `start` and `end`, but `start` and `end` are what the Annotator shows, what SVG and Canvas2D take, and what an Agent can check against bounds.
- **A general gradient `transform` matrix**, as F-DOC-04 sketched. Any affine map of a linear or radial gradient reduces to the fields above, so a matrix adds a second way to say the same thing, and one an Agent cannot read at a glance.
- **Reflect and repeat as a stored `spread`.** SVG has them, but Illustrator does not, and Canvas2D would need the unrolling anyway; unrolling at import keeps the pixels.
- **Midpoints now.** Illustrator has them, but SVG, Inkscape and Canvas2D do not: they would export as extra stops that come back as real ones. Their only editor is the Gradient panel.

## Consequences

- Schema: Fill gains `type: "gradient"` with `gradient`; Stroke gains the same `type`, defaulting to `solid` where read.
- MCP: `node_create` and `node_update` describe gradients and their defaults; `doc_open`'s text and `drawing-conventions.md` stop saying gradients flatten.
- The Canvas2D interface in `packages/render` gains `createLinearGradient` and `createRadialGradient`.
- The round-trip fixture gains linear and radial gradients on Fills, a Stroke and text, including a turned Node, an elliptical radial with a focus, and a stack.
- ADR-0017's Kalamo gap for gradients is closed, and its `GRADIENT_FLATTENED` warning is removed.
- F-DOC-04, F-DOC-05, REQUIREMENTS's example Document and decision 43 change to match.
