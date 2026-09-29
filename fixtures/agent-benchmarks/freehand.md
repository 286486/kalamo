## Prompt

Using the kalamo tools, create a Document named exactly `{{name}}` with one 400×400 pt Artboard at the origin.

Draw freehand, as with Illustrator's Pencil tool, one wavy line: two full periods of a sine wave from (50, 200) to (350, 200), 50 pt above and below that centre line, sampled at least every 10 pt. Give it a 2 pt black Stroke and no Fill. Draw nothing else.

## Assertions

- The Agent called `kalamo_freehand_stroke`.
- The Document holds exactly one shape: an open `path` whose bounds are within 5 pt of x 50 to 350 and y 150 to 250, fitted to curves (at least one `C`, at most 20 segments).
- It has no Fill and one Stroke, `#000000` and 2 pt wide.
