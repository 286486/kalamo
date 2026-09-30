---
status: accepted
date: 2026-09-25
---

# Point Type breaks at hard returns, and Area Type wraps in a rectangle as Inkscape lays it out

ADR-0013 kept Point Type to one line, and ADR-0017's importer split every Inkscape line into its own Node. Designers type several lines, and Inkscape's text tool, dragged, makes flowed text (`shape-inside`), so the round trip needs both (#33, F-TEXT-01, F-TEXT-04). This supersedes ADR-0013's one-line `content` and ADR-0017's "each line tspan is its own Point Type Node".

## The model

- **Point Type** (`kind: "point"`) keeps its fields. `content` may hold hard returns, `\n`, and nothing else breaks a line. Tabs, `\r` and the other control characters are still refused, with a hint to use `\n`. Line *i* starts at `x`, its baseline at `y + i · leading`. Amended by ADR-0077: each line starts where its alignment puts it about `x`. Amended by ADR-0068: each line is its own leading below the one before, which differs only when Character Ranges set sizes.
- **Area Type** (`kind: "area"`) adds `width` and `height`: `x, y, width, height` is its frame, a rectangle in the Node's own coordinates, as Illustrator's Type tool drags one. Amended by ADR-0078: Area Type may also flow in any closed path, its `frame`. Its geometric bounds are the frame, as Illustrator reports an area type object's.
- **Leading** (`leading`, pt) is the distance between baselines, on both kinds. Absent means Auto, 120 % of `fontSize`, which follows the font size as Illustrator's Auto leading does. Amended by ADR-0068: Auto is 120 % of the largest size on each line, the line's own leading. `node_update` with `leading: null` returns to Auto. Nodes and files that have no `leading` stay valid and need no migration.
- **Kind is fixed.** `node_update` cannot turn one kind into the other; Illustrator's Convert to Area Type / Point Type is later work. It can write `width` and `height` of Area Type only. Superseded by ADR-0079: `kind` in a `node_update` patch converts a text, keeping its lines in place.

## One layout, in `core`

One function in `core/text.ts` lays out a text Node into lines, each a string with its baseline start. Amended by ADR-0077: that start is aligned, and a justified line carries its widened word spacing. `bounds`, the Canvas2D renderer and the SVG writer all read it, as they read `textBox` today (ADR-0013). Area Type follows what Inkscape 1.2.2 draws, measured headless on the bundled font, so a file looks the same in both:

- **First baseline** at `y + (leading − fontSize) / 2 + fontSize · ascender / (ascender − descender)`: CSS half-leading with the ascender and descender scaled to sum to one em, which is what Inkscape does. Illustrator's default First Baseline (Ascent) sits higher; matching the editor of the round trip wins. A line holding CJK keeps this first baseline and steps by leading alone (ADR-0080).
- **Wrapping** is greedy at spaces: a line takes words while the advance sum without its trailing spaces fits `width`. The spaces after the last word stay on the line and do not count, and a hard return ends a paragraph. On the sample text these breaks equal Inkscape's. ADR-0064 adds breaks between CJK characters.
- **Overflow.** Line *i* is shown when `(i + 0.9) · leading ≤ height`, the threshold Inkscape keeps (measured at 0.9000 across font sizes and leadings). A word wider than the frame is not split: it and everything after it overflow, as in Inkscape; Illustrator breaks the word, but the file would then show different text in the editor. Overflowing text is not drawn. `node_create` and `node_update` warn `TEXT_OVERFLOW` for each Area Type that does not fit, since an Agent cannot see Illustrator's red overflow mark. A line holding CJK has the same threshold (ADR-0080). Amended by ADR-0083: a line shows while its band lies in the frame, which is this threshold unless the text's own strut reaches lower than the line's box; Inkscape 1.2.2 breaks a word wider than the frame between characters, which #221 takes up.
- The advance sum is still unshaped (ADR-0013). Inkscape kerns, so a line within a fraction of a character of `width` can break differently there.

## SVG

| Kalamo | SVG |
|---|---|
| Point Type | `<text x y>` with one `<tspan sodipodi:role="line" x y>` per line, an empty line as an empty tspan, the way Inkscape writes it |
| Area Type | a `<defs><rect id="area-z-<id>" x y width height/></defs>` just before the text (before its `<g kalamo:stack>`, if any), and `<text style="shape-inside:url(#area-z-<id>);white-space:pre">` holding one `<tspan x y>` per shown line, each keeping its trailing spaces and hard return, then the overflow in a `<tspan style="visibility:hidden">` |
| `leading` | `line-height` in `style`: Auto is the unitless `1.2`, which CSS also scales with the font size; a set leading is `<leading>px`, one user unit per pt |

resvg ignores `shape-inside` and draws the tspans where they are written, so `render` shows the layout above. Inkscape reflows the text in the frame from its content, and on save writes positioned tspans again with every character, the overflow included. The frame's coordinates are the text's user space, as Inkscape reads them.

Import:

- A `<text>` with `sodipodi:role="line"` tspans is one Point Type: the lines joined by `\n`, empty lines kept; `x, y` and the style from the first line. Amended by ADR-0077: `text-anchor` and `text-align` are read as the text's `alignment`, `x` stays the anchor, and nothing warns `text-anchor`.
- A `<text>` whose `shape-inside` names a `<rect>` with no transform of its own is Area Type: the frame is the rect, mapped by the text's matrix like any leaf's parameters, and `content` is the element's text content, with returns kept under `white-space: pre`, `pre-wrap` or `pre-line`. Tspan positions are ignored; the layout is recomputed. A missing reference imports Point Type with `UNSUPPORTED_ATTRIBUTE` `shape-inside`. Amended by ADR-0078: a closed circle, ellipse, polygon, polyline, path or transformed rect imports as that shaped frame without a warning, and any other shape imports as Point Type with the warning.
- `line-height` becomes `leading`: unitless `1.2` or `normal` or none is Auto, another unitless or percentage value is that multiple of `fontSize`, a length converts to pt. A baked scale scales `leading`, `width` and `height` with `fontSize`.

Inkscape's `inline-size` text and `flowRoot` stay as they are: the first imports as one line, the second is dropped with a warning (ADR-0017).

## Considered Options

- **Keep one Node per line.** Editing a paragraph would mean editing several Nodes, and nothing ties them back into one `<text>` for Inkscape.
- **Store `leading` always, defaulting to 1.2 × `fontSize` at create.** Every stored Node and file would need a migration, and a size change would leave the spacing behind, where Illustrator's Auto follows it.
- **Break words wider than the frame**, as Illustrator does. Inkscape hides them instead, so the same file would read differently in the two editors.
- **Illustrator's Ascent first baseline.** At 12 pt with Auto leading it puts the first baseline 12 pt below the frame's top, where Inkscape draws the same file at 10.25 pt.
- **Write overflow as Inkscape does**, positioned below the frame. Browsers and resvg would draw it.

## Consequences

- MCP: `node_create` takes `kind: "area"` with `width` and `height`, and `leading` on any text; `content` may hold `\n`; `node_update` writes `leading`, and `width` and `height` on Area Type. Receipts gain `TEXT_OVERFLOW`.
- The Layers panel's auto-name for a text is its content with returns shown as spaces.
- The overflow threshold and first baseline are measured from Inkscape, not specified; `pnpm roundtrip` is what keeps them honest, and a fixture keeps its lines clear of the frame's edge.
