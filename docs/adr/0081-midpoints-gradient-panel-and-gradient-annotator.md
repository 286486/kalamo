---
status: accepted
date: 2026-09-30
---

# Midpoints, the Gradient panel and the Gradient Annotator

ADR-0026 put linear and radial gradients in Fills and Strokes. It left out midpoints between Color Stops, "which SVG and Inkscape cannot hold and only the Gradient panel edits". This ADR adds them, the Gradient panel, and the Gradient tool with its Annotator (F-APP-04 P0, F-DOC-04, #64). It amends ADR-0026's "Not in this ADR" and its rejected option "Midpoints now".

## The model

A Color Stop gains an optional `midpoint`:

| Field | Type | Meaning |
|---|---|---|
| `midpoint` | number 0.13–0.87, default 0.5 | how far from this stop to the next their colours are mixed 50/50 |

- The range is Illustrator's 13%–87%. 0.5 is not stored, so a gradient without midpoints stays exactly as ADR-0026 stores it, and `.kalamo.json` needs no migration.
- A midpoint stays on the stop it was given on when the stops are sorted by `offset`, stably, as ADR-0026 sorts them.
- The stop that sorts last has no next stop. A `midpoint` on it fails validation at `stops[<its input index>].midpoint`. Among equal highest offsets, the last one given sorts last.
- `node_create`, `node_update` and `node_get` `full` carry it. The schema checks it for input and for stored files alike.

## Drawing

SVG, Inkscape and Canvas2D blend straight between stops. A midpoint is drawn with extra stops along a blend curve, as Illustrator's own SVG export does. `drawnStops` in core does this. The SVG writer's gradient element and the canvas's `styleOf` both use it, so `render`, export and the canvas draw the same colours.

- **The curve.** `u` of the way from a stop to the next, with midpoint `m`, the next stop's colour is mixed in by `w(u) = u^p`, with `p = ln 0.5 / ln m`. So `w(m) = 0.5`, `w(0) = 0` and `w(1) = 1`. Each channel and the alpha are mixed by the same weight.
- **Tolerance.** Between the inserted stops, each channel, on the 0–255 scale, stays within half a step of the curve (`MIDPOINT_TOLERANCE`, 0.5 / 255). Each inserted colour is then rounded to 8 bits, so the drawn colour stays within one 8-bit step of the curve.
- **Placing the stops.** A chord of `u^p` strays most where the curve's slope equals the chord's, which gives the error in closed form. From `u = 0`, each chord is made as long as the tolerance allows, found by bisection. The tolerance is divided by the span's largest channel difference, so a span between near colours needs few stops. Black to white takes 15 stops at `m = 0.25`, 21 at 0.13, 14 at 0.87 and 5 at 0.45.
- **Cap.** At most `MIDPOINT_CAP`, 32, stops go into one span. Past it the tolerance doubles until the stops fit. No 8-bit span reaches the cap.
- A span with no length (a hard edge) or equal colours gets no stops. A gradient whose midpoints are all 0.5 is drawn with its own stops, unchanged.
- An inserted stop's offset keeps 6 decimals, since the curve is steep next to its stop when `m < 0.5`. A stop that rounds onto the offset of its stop, the one before it or the next stop is left out, so no hard edge narrower than 1e-6 is drawn. That happens next to a stop with `m` at or below about 0.145, over less than a millionth of the span.

## SVG

- **Export.** Each inserted stop carries `kalamo:simulated="true"`, and its offset keeps its 6 decimals. Each real stop with a midpoint carries `kalamo:midpoint="<value>"`. The Color Stops keep ADR-0026's form.
- **Import.** A stop marked `kalamo:simulated` is dropped. `kalamo:midpoint` restores the midpoint on its stop, clamped to 0.13–0.87. A stop that ends up last, after SVG's offset clamping, drops it. A value of 0.5 is not stored. A file without the marks, such as one Illustrator exported or Inkscape authored, imports every stop as an ordinary Color Stop with no midpoint. A reflect or repeat gradient that ADR-0026 unrolls drops its midpoints; Kalamo never writes one.
- **Inkscape 1.2.2.** `pnpm roundtrip` passes with the marks: a plain save keeps them, and the fields come back equal. The Gradients Artboard draws 0 differing pixels of its 0.7 % budget. When the designer edits the gradient, Inkscape 1.2.2's source (`src/gradient-chemistry.cpp`) shows what happens; no GUI edit was driven headless:
  - Forking a gradient into a stops-only vector and a positioned gradient duplicates each `<stop>` with all its attributes, so the marks survive.
  - Changing a stop's colour writes `stop-color` in its `style` and keeps its other attributes. Import then keeps the midpoint and takes the new colour. The inserted stops keep their old colours, which import drops.
  - Adding a stop (`sp_vector_add_stop`, `sp_gradient_add_stop`) duplicates the stop before it, attributes and all. A stop added after an inserted stop is therefore marked `kalamo:simulated` and is dropped on import. A stop added after a real stop with a midpoint copies its `kalamo:midpoint`. This is a known limit of the marks. Recognising a stop by its colour on the curve would instead keep the inserted stops once a real stop's colour changes.

## The Gradient panel

Window > Gradient, Illustrator's Ctrl+F9, sits in the one menu table that binds shortcuts (ADR-0031), beside Window > Layers. The panel is docked on the right, above the Layers panel. The store keeps `gradientShown`, as it keeps `layersShown`.

- **What it edits.** The Tools panel's active Fill or Stroke box chooses the paint, as in Illustrator. The panel's own Fill and Stroke buttons set the same state. The paint edited is the topmost Fill (the last in `fills`) or the topmost Stroke of every editable leaf with an Appearance in the Selection, and in its Groups. The panel shows the first such leaf's paint. With none, or for a viewer, it is disabled. A leaf with no Fill or Stroke gets one: a new Stroke is 1 pt, butt, miter. A solid Stroke becoming a gradient keeps its width, cap, join, miter limit and dash.
- **Thumbnail.** On a solid paint or none, a click applies Illustrator's default gradient, white to black, linear, with ADR-0026's default geometry from each leaf's own bounds. On a gradient it does nothing.
- **Type.** Linear or Radial. Switching keeps the stops and midpoints and takes the new type's default geometry.
- **Reverse.** Each offset becomes `1 − offset`. The midpoint of the span from stop `i` to `i + 1` moves to the mirrored span as `1 − m`, on the stop that now starts it, the old stop `i + 1`.
- **Angle.** It is shown and set as the page shows it, through the leaf's world transform, as Illustrator shows it. For a linear gradient, setting it turns the vector about `start` and keeps its length in the leaf's own coordinates. For a radial gradient, it sets `angle`, the own direction that shows at that page angle.
- **Aspect Ratio**, radial only, is shown as a percentage. The focus is kept inside the ellipse, as ADR-0026 stores it.
- **The slider.**
  - A click below it adds a stop in the colour the gradient has there, and selects it. The span's midpoint goes back to 50 %, as Illustrator's does.
  - A stop dragged along it moves, keeping its colour and midpoint. A midpoint on a stop that ends up last is dropped.
  - A stop dragged 24 px down off the slider, or removed with the Delete button, is removed. This is refused while only two stops remain. After a drag, the fields show the dragged stop wherever it sorted.
- **Keyboard.** Each Color Stop and midpoint diamond is a button, and focusing one with Tab selects it. On a focused stop, Delete or Backspace removes it, refused while only two stops remain; a midpoint cannot be deleted. The arrow keys move the focused stop, or the focused midpoint within its span, by 1 %, or 10 % with Shift. The keys a panel control takes (Delete, Backspace, the arrows, Space and Enter) stop at the panel, so they never Clear or nudge the Selection or pan the canvas. Keys with Ctrl, such as Undo, still reach the menu bar.
  - Midpoint diamonds sit above the slider, and each drags within 13 %–87 % of its span.
- **The selected stop** has its colour (the browser's colour input, as the Fill box uses), Opacity % (its alpha, since the model has no separate stop opacity) and Location %. A selected midpoint has its Location %.
- Every edit applies the panel's stops to every target. A solid target takes the default geometry.
- **Transactions.** Each discrete change is one Transaction, so one undo step. A number field commits on Enter or blur, not per keystroke. A drag previews live and commits once, on release. The colour picker commits on its `change` and previews nothing, since a picker closed without choosing fires no event that would take a preview back. A change, drag or key that leaves every paint as it was sends nothing, so it adds no empty undo step.

## The Gradient tool and the Annotator

The Gradient Tool, Illustrator's G, is a `CanvasTool` like the other tools.

- **Drag.** Dragging with leaves selected sets their active paint's geometry, applying the default gradient first to a solid paint or none.
  - Linear: `start` at the press, `end` at the release. Shift constrains the drag to 45° steps on the page.
  - Radial: `center` and `focus` at the press, `radius` to the release. The aspect ratio and angle stay.
  - The positions are mapped into each leaf's own coordinates through the inverse of its world transform (ADR-0007, ADR-0026), and rounded to 3 decimals, as export writes them.
- **The Annotator** shows on one selected leaf whose active paint is a gradient. It is drawn on the overlay canvas, sized in screen pixels:
  - Linear: the bar from `start` to `end`. The round origin end moves the whole vector, and the square end moves `end`.
  - Radial: the bar from `center` along `angle` to `radius`, and the dotted ellipse. The aspect ratio handle sits on the ellipse across `angle`, and the focus handle sits at `focus`, kept inside the ellipse. The end handle sets `radius` and `angle`. A focus on the origin moves with it, and Alt+drag takes the focus alone, to pull it off the origin.
  - Color Stops sit 12 px below the bar, on its clockwise normal. They drag along it and leave it, while more than two remain, when dragged more than 24 px beyond their row. A click on the bar adds one there, and a double-click on a stop opens its colour. Midpoint diamonds sit 9 px above the bar and drag within 13 %–87 % of their span.
  - Every handle is hit within 6 screen px, through the leaf's rotated or scaled transform. Stops come first, then midpoints, the origin, the focus, the aspect handle, the end, and the bar.
- Each drag previews and commits one Transaction on release. Escape cancels it. A drag that changes nothing, such as tearing off a stop while only two remain, commits nothing.

A preview is `paintPreview` in the store: each Node's new paints, drawn over the Document until the answer to its command arrives, as a Direct Selection drag is drawn (ADR-0010).

## The browser command

A new WebSocket command writes paint lists:

```jsonc
{ "type": "appearance", "updates": [{ "nodeId": "…", "appearance": { "fills": [ … ] } }] }
```

- The Document Durable Object parses `appearance` with the same `Fill` and `Stroke` schemas as `node_update`'s Appearance, since browsers are not trusted (ADR-0010).
- `fills` and `strokes` are both optional, but one of them must be given.
- Every Node is written in one Transaction of the User Actor, so one undo step, through the same `updateNodes` as `node_update`.
- A patch the schema refuses closes the socket as a malformed command, as ADR-0010 does. A patch that core refuses, such as a colour name, is answered with `rejected` and changes nothing.
- The Layers panel's `update` stays as it is.

## Considered Options

- **Midpoints as real stops.** Export already needs inserted stops, and storing them would make the panel show a dozen stops for one midpoint and lose the midpoint on the round trip.
- **Illustrator's own curve.** Adobe does not document its midpoint curve. The power curve is the simplest monotone curve that is 0.5 at `m` and meets both stops, and the tolerance bounds how far every renderer strays from it.
- **Stops at fixed fractions, or equal colour steps.** Fixed fractions miss the steep end of `u^p` next to the stop. Equal colour steps need 255 stops for black to white to guarantee one step. The greedy chords need 5 to 21.
- **Recognising inserted stops by colour instead of marks.** This would survive Inkscape duplicating a marked stop. But a real stop's colour changed in Inkscape moves the curve, so every inserted stop would come back as a real one.
- **The Angle in the leaf's own coordinates.** That is the stored space, but on a turned Node the panel would show a number the page does not.
- **One gradient across several objects, and the Annotator with the Selection tool.** Illustrator has both, and #64 leaves them out.

## Consequences

- Core gains `ColorStop.midpoint`, `MIDPOINT_MIN` and `MIDPOINT_MAX`, and `midpoint.ts` with `drawnStops`, `blend`, `mix` and `colorAt`. `clampFocus`, the focus clamp ADR-0026 stores, and `alphaOf` and `withAlpha`, a colour's alpha, move into core, so the reader, writer, panel and Annotator share them.
- `io`'s dialect gains `kalamo:midpoint` and `kalamo:simulated`, and the round-trip fixture gains a midpoint on its linear Fill and a radial Stroke with two.
- `@kalamo/sync`'s `ClientMessage` gains `appearance`. The web app gains the Gradient panel, the Gradient Tool, Window > Gradient and `paintPreview`.
- ADR-0026's "Not in this ADR" and its "Midpoints now" option are amended by this ADR. CONTEXT.md gains **Midpoint**, **Gradient panel** and **Gradient Annotator**. REQUIREMENTS F-APP-04 and F-DOC-04 change to match.
