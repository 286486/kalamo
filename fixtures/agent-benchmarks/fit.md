## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 600×800 pt Artboard at the origin.

Set the paragraph below in a text box 320 pt wide whose top-left corner is at (140, 120): 16 pt Source Sans 3, justified. Then draw a 1 pt `#3D3D44` rectangle, with no Fill, exactly around the text box: 320 pt wide, and just tall enough for the text, with no line cut off and no more than one empty line below the last line.

Kalamo is a vector editor that runs in the browser. AI agents draw on it through the Model Context Protocol, and people edit the very same document on an Illustrator-style canvas. Whatever an agent makes stays as paths, shapes and text, never as a flat picture, so anyone can pick up a curve, drag an anchor, retype a heading or change a colour and keep working by hand. When the person is done, the agent can read back exactly what changed and carry on from there, without redrawing the whole page or undoing the edits a person made along the way.

## SVG prompt

Write an SVG file, `out.svg`, in the current directory: one 600×800 pt page, with one user unit to the pt.

Set the paragraph below as SVG text (`<text>`, which Inkscape can edit, not HTML) in a text box 320 pt wide whose top-left corner is at (140, 120): 16 pt Source Sans 3, justified. Then draw a 1 pt `#3D3D44` rectangle, with no fill, exactly around the text box: 320 pt wide, and just tall enough for the text, with no line cut off and no more than one empty line below the last line.

Kalamo is a vector editor that runs in the browser. AI agents draw on it through the Model Context Protocol, and people edit the very same document on an Illustrator-style canvas. Whatever an agent makes stays as paths, shapes and text, never as a flat picture, so anyone can pick up a curve, drag an anchor, retype a heading or change a colour and keep working by hand. When the person is done, the agent can read back exactly what changed and carry on from there, without redrawing the whole page or undoing the edits a person made along the way.

## Assertions

The SVG arm's `out.svg` is opened in Kalamo, which lays out its text, and checked the same way.

- The Document holds one rect and texts that read the paragraph, in order, with nothing else.
- The rect has one 1 pt `#3D3D44` Stroke and no Fill, and is 320 pt wide at x 140, within 1 pt; its top is the text box's (y 120) or the first line's, whose ascender may rise above the box, and that line's top is within 4 pt of y 120.
- The texts' lines, as Kalamo lays them out (an Area Type's `lineBounds`, a Point Type's bounds), lie within the rect's sides and above its bottom, which is at most 24 pt (one 16 pt line's leading and a little) below theirs.
- In an SVG with `<tspan>`, a text Kalamo opens as one line wider than the page fails as unjudged: SVG Open joins tspans positioned by `x` and `dy` into one line until #238.
