---
status: accepted
date: 2026-09-30
---

# Paragraph alignment aligns every line of a text, and round-trips as Inkscape writes it

F-TEXT-03 (P0) asks for Illustrator's Paragraph panel alignment: left, center, right and justify. ADR-0022 left-aligned every line. On import it moved a one-line centred Point Type's `x` to the line's start and dropped the alignment, and for more lines it warned `UNSUPPORTED_ATTRIBUTE` `text-anchor` (#58). This amends ADR-0022's layout and import sections.

## The model

- **`alignment`** on a text: `"left" | "center" | "right" | "justify"`. Absent means left, and left is not stored: create, update, `.kalamo.json` Open and SVG import all drop an explicit left, so a Node never differs by it, and Nodes and files from before need no migration. `justify` is Illustrator's "Justify with last line aligned left", its default justify mode. There is one alignment per text, not per paragraph, as the character attributes are Node-level (ADR-0013, ADR-0029).
- **MCP.** `node_create` and `node_update` take `alignment`, and `node_update` with `alignment: null` goes back to left. The input schema is strict (ADR-0050): another value fails at `alignment`. `node_get` `full` returns it when it is set. Receipt and `node_get` bounds follow the aligned layout.

## The layout, in `core`

`layoutText` aligns each line after ADR-0022 has broken and stacked them. So wrapping, overflow, `TEXT_OVERFLOW` and every baseline are the same for every alignment. A line's width, the one alignment measures, is its advance sum without its trailing whitespace and without the tracking after its last character. Trailing whitespace is what ADR-0022's wrapping already hangs, JavaScript's `\s`: the space, the hard return, the no-break space U+00A0, the ideographic space U+3000 and the other Unicode spaces. Inkscape was measured with trailing U+0020 only; a trailing U+00A0 or U+3000 was not measured.

- **Point Type** aligns about the anchor `x`, as Illustrator does. Each line starts at `x` (left), `x − width/2` (center) or `x − width` (right). `justify` lays out as left, as Illustrator does for point type, but it is stored and round-trips.
- **Area Type** aligns each shown line in the frame, `x` to `x + width`: it starts at `x + (frameWidth − width)/2` (center) or `x + frameWidth − width` (right).
- **Justify** stretches each line of Area Type to the frame's width, by widening only the spaces (U+0020) before its last word; a no-break space or U+3000 is never widened. The brief takes this from Illustrator's default Justification, word spacing only with letter spacing 0. A line gets `wordSpacing`, the extra pt after each such space. A paragraph's last line stays left: one ending at a hard return, or the text's last shown line. So does a line with no space to widen, such as a single word or unspaced CJK.
- **Characters.** `glyphs` gives each character its aligned origin, a justified line's widened spaces included. So baseline shift, rotation and tracking (ADR-0029, ADR-0068) move with the line. Point Type's `textBox` is the union of the aligned lines and their cells. Area Type's is still its frame. `render`, the canvas and export read `layoutText` and `glyphs` and never re-derive alignment.
- **Canvas.** An aligned line is drawn from its start. A text with a justified line paints each character at its origin, through the path that tracking and ranges already use.

## SVG

What Inkscape 1.2.2 writes was measured by saving a text of each kind in each alignment through `inkscape --export-type=svg`:

| Kalamo | Inkscape writes | Kalamo writes |
|---|---|---|
| Point Type center / right / justify | `text-align:center;text-anchor:middle`, `text-align:end;text-anchor:end`, `text-align:justify;text-anchor:start`; every line tspan at the anchor `x` | the same, after `line-height` |
| Area Type center / right / justify | `text-align:center` / `end` / `justify` only, with `text-anchor` dropped even when the input had both; positioned tspans at each line's aligned start; a justified line gets `dx` on each character after a widened space | the same `text-align`; tspans at the aligned starts; on a justified line each character after a widened space starts its own chunk at its `x` |
| left | `text-align:start;text-anchor:start` | nothing, so a left text writes the same bytes as before |

resvg reads neither `text-align` nor `shape-inside`. For `render`, each line starts where the layout puts it and neither property is written, so resvg draws the layout exactly. The same goes for the per-family chunks, which `text-anchor` would otherwise align one by one (ADR-0063).

A justified line uses chunks rather than `word-spacing`, because resvg widens U+00A0 by `word-spacing` too, while the layout widens only U+0020. Inkscape reflows the frame from its content by `text-align` and ignores the positions.

What was measured for `text-anchor`, drawing the same file in both at 40 px with `letter-spacing:10`: `HH` anchored at the end and in the middle, `H H` and `H  H` at the end, and, untracked, `HH ` with a trailing space at the end:

- **resvg (resvg-wasm 2.6.2)** leaves out the trailing `letter-spacing` of a centred or right-aligned line, and counts its trailing spaces.
- **Inkscape 1.2.2** leaves out both, and its inner spaces and tracking match the layout's advances to the pixel. For flowed text, its saved line starts for `text-align:center` and `end` show line widths without the trailing space.
- **Kalamo** follows Inkscape, the round-trip editor, and its own Area Type rule (ADR-0022): a trailing space hangs. The only file that differs is an exported Point Type line that ends in spaces, read by resvg or a browser, not by Inkscape.
- **Inkscape at 12 pt with `letter-spacing`** anchors a right-aligned Point Type line with spaces left of the layout, by about 0.6 pt per space; the cause was not identified. The fixture text first tried was `Right aligned\nlines end here\nok`, 12 pt, tracking 80 (0.96 pt), right-aligned at `x` 610. resvg's ink sat 0.71 px, 1.27 px and −0.05 px right of Inkscape's on its three lines, which hold one, two and no spaces, and 696 of the region's 4263 pixels differed (16.3% of a 15% budget). The same text left-aligned differed in 6 pixels (0.14%). The fixture's right-aligned Point Type is untracked, and its untracked centred and right-aligned texts come within 3.3% and 2.7%. Tracked centred Point Type and tracked aligned Area Type were not measured. This remains a known difference.

Import (`doc_open`, `svg_import`) reads the alignment and keeps `x` at the anchor. The `UNSUPPORTED_ATTRIBUTE` `text-anchor` warning is gone.

- **Point Type:** `text-anchor` start, middle and end map to left, center and right. `text-align:justify` with a start anchor maps to justify.
- **Area Type:** `text-align` `start` or `left`, `center`, `end` or `right`, and `justify` map to the four values. Without `text-align`, it falls back to `text-anchor`. Tspan positions are ignored, as before.
- **Disagreement:** if the line tspans of one Point Type disagree, the first line's value wins, and the import warns `UNSUPPORTED_ATTRIBUTE` once, naming the property.
- **Baked scale:** it needs nothing for alignment.

## Considered Options

- **Keep moving `x` on import, and store no alignment.** Rejected: a centred multi-line text could not round-trip, and editing it would re-centre nothing.
- **Count trailing spaces in Point Type's width, as resvg does.** Rejected: Inkscape, the editor of the round trip, does not, and Area Type already hangs them (ADR-0022).
- **`word-spacing` per justified line.** Rejected: resvg widens U+00A0 too, so it would draw differently from the layout. Explicit positions are exact everywhere.
- **Write `text-anchor` for Area Type too.** Rejected: Inkscape drops it for flowed text, and a renderer that reads it would align each positioned tspan a second time.
- **Illustrator's other justify modes and the Justification dialog's ranges.** Out of scope for #58, as are indents, space before and after, and alignment per paragraph.

## Consequences

- `TextLine.x` is the aligned start, and `TextLine.wordSpacing` is a justified line's extra space. Code that reads lines or glyphs needs no change.
- Receipts and `node_get` bounds move when `alignment` changes. The Selection box and hit tests follow `textBox`.
- `pnpm roundtrip` carries an Alignment Artboard with centred and right-aligned multi-line Point Type, a justified Point Type, and centred, right and justified Area Type, the justified one with two paragraphs. Every field comes back equal, Inkscape's reflowed lines match the layout's, and each text region is within the 15% budget.
- There is still no Paragraph panel or Type tool in the browser. An Agent or an imported file sets alignment.
