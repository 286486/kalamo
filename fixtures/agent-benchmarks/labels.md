## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 600×200 pt Artboard at the origin.

Draw three shapes in a row, each about 60 pt across, with room between them: a red circle, a green square and a blue triangle. To the right of each shape, within 40 pt of it, place a text label naming it, `Circle`, `Square` or `Triangle`, vertically centred on its shape and not overlapping any shape. Draw nothing else.

## SVG prompt

Write an SVG file, `out.svg`, in the current directory: one 600×200 pt page, with one user unit to the pt. Use font-family `Source Sans 3` for any text.

Draw three shapes in a row, each about 60 pt across, with room between them: a red circle, a green square and a blue triangle. To the right of each shape, within 40 pt of it, place a text label naming it, `Circle`, `Square` or `Triangle`, vertically centred on its shape and not overlapping any shape. Draw nothing else.

## Assertions

- The Document holds exactly three texts, `Circle`, `Square` and `Triangle`, and three other shapes: an `ellipse`, a `rect` and a `polygon` or `path`.
- Each label's nearest shape to its left is the one it names, at most 40 pt away, with overlapping vertical ranges; no label overlaps any shape.
- The SVG export has exactly three `<text>`.
- The SVG arm's `out.svg`, opened in Kalamo, passes the same assertions.
