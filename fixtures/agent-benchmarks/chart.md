## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 600×400 pt Artboard at the origin.

Draw quarterly sales for three regions as a column chart filling most of the Artboard, in thousands of dollars: North 120, 150, 170 and 160 for Q1 to Q4, South 80, 95, 110 and 125, and West 100, 90, 130 and 140. Draw nothing else.

## Assertions

- The Document holds exactly one Group named `Column Graph`.
- It holds one Group per region, named `North`, `South` and `West` in any case, each with exactly four rects, one named after each quarter, `Q1` to `Q4`.
- The rects' heights are proportional to the values, within 1%.
