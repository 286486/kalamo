## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 600×600 pt Artboard at the origin.

In it, add a Layer named `Grid` holding a 10×10 grid of 100 rectangles: each 40×40 pt, with 10 pt gaps between them, the top-left one at (50, 50). Fill every rectangle with `#3366CC` and give none a Stroke. Draw nothing else.

## SVG prompt

Write an SVG file, `out.svg`, in the current directory: one 600×600 pt page, with one user unit to the pt.

In it, add an Inkscape layer named `Grid` (`<g inkscape:groupmode="layer" inkscape:label="Grid">`) holding a 10×10 grid of 100 rectangles: each 40×40 pt, with 10 pt gaps between them, the top-left one at (50, 50). Fill every rectangle with `#3366CC` and give none a stroke. Draw nothing else.

## Assertions

- A top-level Layer named `Grid` holds exactly 100 `rect` Nodes, and the Document holds no other shapes.
- Their bounds are 40×40 at x and y in 50, 100, …, 500, one per cell.
- Each has one Fill `#3366CC` and no Stroke; the SVG export has exactly 100 `<rect>`.
- The MCP arm's `kalamo_node_create` calls list at most 10 `rect` Nodes in all, inline children included: one row by hand, then `kalamo_node_duplicate` or `split_into_grid` for the rest.
- The SVG arm's `out.svg`, opened in Kalamo, passes the same assertions; its prompt spells out the Inkscape layer markup, which is how an SVG file holds a Layer.
