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

`layoutText` aligns each line after ADR-0022 has broken and stacked them. So wrapping, overflow, `TEXT_OVERFLOW` and every baseline are the same for every alignment. A line's width, the one alignment measures, is its advance sum without its trailing whitespace and without the tracking after its last character. Trailing whitespace is what ADR-0022's wrapping already hangs: every character JavaScript's `/\s/` matches, U+00A0 and U+3000 among them. Inkscape was measured with trailing U+0020 only; a trailing U+00A0 or U+3000 was not measured.

- **Point Type** aligns about the anchor `x`, as Illustrator does. Each line starts at `x` (left), `x − width/2` (center) or `x − width` (right). `justify` lays out as left, as Illustrator does for point type, but it is stored and round-trips.
- **Area Type** aligns each shown line in the frame, `x` to `x + width`: it starts at `x + (frameWidth − width)/2` (center) or `x + frameWidth − width` (right).
- **Justify** stretches each line of Area Type to the frame's width, by widening only the spaces (U+0020) before its last word; a no-break space or U+3000 is never widened. #58 takes this from Illustrator's default Justification, word spacing only with letter spacing 0. A line gets `wordSpacing`, the extra pt after each such space. A paragraph's last line stays left: one ending at a hard return, or the text's last shown line. So does a line with no space to widen, such as a single word or unspaced CJK.
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
- **Inkscape 1.2.2** leaves out both on a text's last line, and its inner spaces and tracking match the layout's advances to the pixel. Every line before the last is anchored differently: see "Inkscape's lines before the last" below. For flowed text, its saved line starts for `text-align:center` and `end` show line widths without the trailing space.
- **Kalamo** measures every line as Inkscape measures a text's last line, which is also its own Area Type rule (ADR-0022): the trailing whitespace and the letter-spacing after the last character hang. An exported Point Type line that ends in spaces, read by resvg or a browser, lands the width of its spaces away from the layout. Kalamo's own `render` is not affected: it gives resvg each line's laid-out start and no anchor, so resvg draws the layout by construction.

Import (`doc_open`, `svg_import`) reads the alignment and keeps `x` at the anchor. The `UNSUPPORTED_ATTRIBUTE` `text-anchor` warning is gone.

- **Point Type:** `text-anchor` start, middle and end map to left, center and right. `text-align:justify` with a start anchor maps to justify.
- **Area Type:** `text-align` `start` or `left`, `center`, `end` or `right`, and `justify` map to the four values. Without `text-align`, it falls back to `text-anchor`. Tspan positions are ignored, as before.
- **Disagreement:** if the line tspans of one Point Type disagree, the first line's value wins, and the import warns `UNSUPPORTED_ATTRIBUTE` once, naming the property.
- **Baked scale:** it needs nothing for alignment.

## Inkscape's lines before the last

Amended by #196. #58 saw a tracked, right-aligned Point Type land left of the layout in Inkscape, and guessed a hinted space advance. Measuring each line's ink box with `inkscape --query-all` rules the guess out. The same lines were drawn once anchored and once at an explicit start, and the difference gives the width Inkscape anchors by. The cases were `sodipodi:role="line"` tspans in Source Sans 3, anchored at the middle and at the end, in four size and tracking pairs: 12 pt at tracking 0, 12 pt at 80, 24 pt at 125 and 40 pt at 250 (letter-spacing 0, 0.96, 3 and 10 pt). The lines were `HH`, `H H`, `HH `, `HH  `, `H` + U+00A0 + `H`, and `HH` followed by a trailing U+00A0 or U+3000, each as a line before the last and as a text's last line.

- **A text's last line** is anchored by the layout's width in every pair, to 0.005 pt, with its trailing U+0020, U+00A0 or U+3000 hanging. So is a text of one line.
- **Every line before the last** is anchored by a width that adds its trailing whitespace (each character's advance and the letter-spacing after it) and the letter-spacing after its last character. At 12 pt and tracking 80 that is 0.96 pt on `HH` and 4.32 pt on `HH ` (2.4 + 2 × 0.96). At 40 pt and tracking 250 it is 10 and 28 pt. A trailing U+00A0 counts exactly as a space (2.4 pt untracked, 4.32 pt at tracking 80, both at 12 pt), and a trailing U+3000 at its full em (12 and 13.92 pt). The extra does not depend on size beyond the advances and letter-spacing themselves. It does not depend on the spaces inside the line, and it is the same with and without `text-align`, whether the letter-spacing is on `<text>` or on the tspans, and with plain positioned tspans. An untracked line before the last that ends in whitespace is affected too.
- **So** an end-anchored line lands that extra left of the layout in Inkscape, and a centred one half of it. #58's "0.6 pt per space" was one letter-spacing on each of the two lines before the last, which happen to hold one and two spaces. Their ink boxes show 0.96 and 0.84 pt, the second less that line's −0.12 pt unshaped width difference; #58's pixel centroids, 0.71 and 1.27 px, also carried resvg's and Inkscape's rasterisation. A one-line text, which #58's 40 px probes drew, has only a last line.
- **Area Type is not affected.** Inkscape's reflowed line starts for centred and right Area Type in the same four pairs differ from the layout's by the unshaped widths only (ADR-0013). They are 0 to 1.64 pt, the right-aligned exactly twice the centred, and do not grow with tracking: at tracking 250, whose letter-spacing is 10 pt, they are 0 and 1.64 pt.

The layout is not changed to follow this. A line's anchoring would then depend on whether another line follows it, which Illustrator's Paragraph panel has no reason to do. The export does not compensate either, because every lever was tried or ruled out:

- **A line tspan's own `x`.** Inkscape ignores it on a `sodipodi:role="line"` tspan, drawing the line at the `<text>`'s anchor, although it keeps the attribute on save.
- **Letter-spacing or spacing overrides on a line's last characters.** These would import back as Character Ranges the Node never had.
- **One `<text>` per line.** This would break ADR-0022's one text per `<text>`.
- **Lines at the layout's starts with no anchor**, as `render` writes them. Inkscape would draw them in place, but the file would no longer say the text is aligned: import would read it as left-aligned, and an edit in Inkscape would no longer re-align the lines.

So `pnpm roundtrip` gives such a text its own budget, `anchored Point Type`: a centred or right-aligned Point Type with a line before its last that Inkscape anchors away from the layout, one that ends in whitespace (any character JavaScript's `/\s/` matches) or whose last character tracks, by the text's tracking or a Character Range's. Tracking 0, and tracking only inside a line or only on the last line, leave a text at 15%; a repo test pins this. The budget is 25%, as for mixed sizes, above the 16.3% and 15.2% measured for the fixture's two such texts, each line shifted by one letter-spacing or a space and two letter-spacings. Every other text keeps 15%.

## Considered Options

- **Keep moving `x` on import, and store no alignment.** Rejected: a centred multi-line text could not round-trip, and editing it would re-centre nothing.
- **Count trailing spaces in Point Type's width, as resvg does.** Rejected: Inkscape, the editor of the round trip, does not on a text's last line, and Area Type already hangs them (ADR-0022). That Inkscape counts them, and the last tracking, on the lines before (#196) is its line handling, not a rule the layout should follow.
- **`word-spacing` per justified line.** Rejected: resvg widens U+00A0 too, so it would draw differently from the layout. Explicit positions are exact everywhere.
- **Write `text-anchor` for Area Type too.** Rejected: Inkscape drops it for flowed text, and a renderer that reads it would align each positioned tspan a second time.
- **Illustrator's other justify modes and the Justification dialog's ranges.** Out of scope for #58, as are indents, space before and after, and alignment per paragraph.

## Consequences

- `TextLine.x` is the aligned start, and `TextLine.wordSpacing` is a justified line's extra space. Code that reads lines or glyphs needs no change.
- Receipts and `node_get` bounds move when `alignment` changes. The Selection box and hit tests follow `textBox`.
- `pnpm roundtrip` carries an Alignment Artboard with centred and right-aligned multi-line Point Type, a justified Point Type, and centred, right and justified Area Type, the justified one with two paragraphs. The right-aligned Point Type tracks, and a tracked centred one has a line ending in a space (#196). Every field comes back equal, Inkscape's reflowed lines match the layout's, the two tracked anchored texts are within the 25% `anchored Point Type` budget, and every other text region is within 15%.
- There is still no Paragraph panel or Type tool in the browser. An Agent or an imported file sets alignment.
