## Prompt

Using the zibel tools, open the Document named exactly `{{name}}`. It has one 800×600 pt Artboard and a Layer named `Logo`.

Place the SVG below into the `Logo` Layer at its own size, with the centre of its bounds at (560, 150). Change nothing else in the Document.

```svg
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="240" height="120" viewBox="0 0 240 120">
  <title>Acme logo</title>
  <g inkscape:groupmode="layer" inkscape:label="Mark">
    <circle cx="60" cy="60" r="50" fill="#e4572e"/>
    <rect x="35" y="35" width="50" height="50" fill="#ffffff"/>
  </g>
  <g inkscape:groupmode="layer" inkscape:label="Wordmark">
    <rect x="130" y="45" width="100" height="30" fill="#29335c"/>
  </g>
</svg>
```

## Assertions

- The Agent called `zibel_svg_import` and never `zibel_node_create`; a Place change created the Group, and no change after the setup touches anything but what it placed.
- The `Logo` Layer holds exactly one Group, whose children are the Groups `Mark` (two Nodes) and `Wordmark` (one Node).
- The Group's bounds are 220×100 with their centre at (560, 150).
