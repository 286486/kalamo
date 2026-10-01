## Prompt

Using the kalamo tools, open Document `{{docId}}`. You drew it, up to rev 2; someone else has edited it since.

Recolour every dot filled `#E63946` to `#3565E8`, except the Nodes the other person changed after rev 2: they have the final say on those, so leave them exactly as they are. Change nothing else.

## SVG prompt

You drew `drawing.svg` in the current directory; `mine.svg` is a copy of it as you left it. Someone else has edited `drawing.svg` since.

Edit `drawing.svg` in place. Recolour every dot filled `#E63946` to `#3565E8`, except the elements the other person changed: they have the final say on those, so leave them exactly as they are. Change nothing else.

## Assertions

The setup draws six dots and a caption as one Actor (rev 2), then, as another, moves `Dot 3` up 40 pt, recolours `Dot 5` `#2A9D8F` and retypes the caption.

- The Document holds the six circles `Dot 1` to `Dot 6` and the caption, nothing else.
- `Dot 1`, `Dot 2`, `Dot 4` and `Dot 6` are `#3565E8` where they were; `Dot 3` is still `#E63946`, 40 pt up; `Dot 5` is still `#2A9D8F`.
- The caption reads `Six dots, one raised`.
- The SVG arm's `drawing.svg`, opened in Kalamo, passes the same assertions.
