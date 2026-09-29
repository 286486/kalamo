## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 600×600 pt Artboard at the origin.

In it, add a Layer named `Grid` holding a 10×10 grid of 100 rectangles: each 40×40 pt, with 10 pt gaps between them, the top-left one at (50, 50). Fill every rectangle with `#3366CC` and give none a Stroke. Draw nothing else.

## Assertions

- A top-level Layer named `Grid` holds exactly 100 `rect` Nodes, and the Document holds no other shapes.
- Their bounds are 40×40 at x and y in 50, 100, …, 500, one per cell.
- Each has one Fill `#3366CC` and no Stroke; the SVG export has exactly 100 `<path>`.
