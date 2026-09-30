---
status: accepted
date: 2026-09-30
---

# Area Type stacks lines by leading alone, whatever family a line draws in

ADR-0064 stacked a rectangular Area Type line that holds CJK as Inkscape 1.2.2 drew it. Each family on the line had a CSS inline box, and the line was the union of those boxes with the text's first family's box, the strut. So a line with Noto Sans SC beside Source Sans 3 sat lower than its leading. Point Type stacked the same line by its leading, so Convert to Area Type and Convert to Point Type (ADR-0079) moved it. Illustrator stacks both kinds by leading alone (#199). This ADR follows Illustrator and makes export write a form that Inkscape 1.2.2 draws the same way. It amends ADR-0064's "A line holding CJK is as tall as Inkscape stacks it", ADR-0068's Area Type bullet, and ADR-0079's "CJK in a fallback family". The evidence is in `docs/research/08-line-stacking.md`.

## Decision

- **Stacking.** In a rectangular Area Type the first baseline is ADR-0022's. It lies `(leading − size) / 2 + size · ascent` below the frame's top. `ascent` is the text's first family's em-box ascent (ADR-0064), and `size` and `leading` are the first line's (ADR-0068). Each later baseline is that line's leading below the one before, as Point Type computes it: the Node's leading, or with Auto 120 % of the largest size on the line, its hard return included. The families a line draws in do not change it. Illustrator Help says leading is measured from baseline to baseline, and that Auto is 120 % of the type size. It says nothing of a substitute font's glyphs changing a line's leading. Missing Glyph Protection substitutes a glyph and leaves the leading alone.
- **Show and overflow.** A line shows while 90 % of its leading lies in the frame, measured from its top. That is ADR-0022's threshold. The first line's box is one leading tall, so the same rule covers it. ADR-0064's other two thresholds are removed: 90 % of a CJK first line's taller height, and the whole leading for a later line taller than the strut. With the export below, Inkscape 1.2.2 shows every CJK line at the Latin threshold, under Auto and a set leading.
- **Export.** In the SVG for Inkscape and browsers, each run of characters that draws in a bundled family whose em-box ascent differs from the text's first family's gets `line-height` as a style on its own tspan. The value is the run's leading less twice that difference, in the run's own em: unitless `1.2 − 2·|Δ|` with Auto, and `leading − 2·|Δ|·size` px with a set leading, rounded down to a thousandth. For CJK in Source Sans 3 it is `0.948`. The run's inline box then lies inside the box a first-family run of its size and leading would have. Inkscape stacks the line as a first-family line, and its first baseline is ADR-0022's. The value is rounded down because a box a thousandth of a pixel above the strut makes Inkscape need the line's whole leading in the frame. Noto Sans SC and Noto Sans KR have equal boxes, so a Noto text's Hangul, and a Source Sans 3 text's Latin, get no such style. A Noto Sans SC text's Source Sans 3 range does get one. resvg's chunked SVG keeps each line's `y` and gets none. `core`'s `runLineHeight` computes the value, and `io`'s writer is the only place that writes it.
- **Import** ignores `line-height` on a tspan inside a line, as it did before, so the export Opens back as the same Node.
- **Conversion.** Both kinds now stack by leading, so Point to Area and Area to Point keep every glyph of a text with CJK in a fallback family in place, to the 3 decimals a conversion keeps. ADR-0079's "CJK in a fallback family" section no longer applies.
- **Unchanged.** A text whose characters all draw in its first family lays out and exports exactly as before, all-Latin Source Sans 3 and all-CJK Noto Sans SC alike. Point Type's layout does not change.

## Measurements

Inkscape 1.2.2, headless, with the bundled fonts: 20 px Source Sans 3 with `字字` in Noto Sans SC, Auto leading and leading 30, CJK on the first or a later line and at 30 px. Point Type and Area Type were each written in four forms. Only the per-run `line-height` puts every line of the text's size at leading-only baselines in both kinds, with ADR-0022's first baseline and Latin overflow thresholds. Without it, a CJK line sat 2.52 px lower, in Point Type as well as Area Type. An absolute `line-height` on the text does the same. Noto Sans SC as the first family stacks by leading, but it moves every Area Type's first baseline and draws the Latin in Noto. The research note has the tables and the script.

A CJK run larger than the line's other characters puts that line where Inkscape puts a Latin run of that size, 32.54 px below the line before at 30 px in a 20 px text, where Illustrator's rule gives 36 at Auto and 30 at 30. The next line is where Illustrator puts it. That is ADR-0068's model difference for mixed sizes, which the round trip's `mixed-size text` budget already covers.

`pnpm roundtrip` passes with a new "CJK Line Stacking" Artboard. It holds a three-line Point Type whose later lines mix Latin and CJK, at 4.24 % of the 15 % text budget, and an Area Type at leading 18 whose last shown line is CJK and sits 0.8 pt inside its threshold, at 3.83 %. Inkscape shows the same lines. The CJK and Korean Area Types differ by 1.16 % and 0.5 %. Without the run `line-height`, Inkscape hides the new Area Type's third line and the text regions differ by 20.9 % to 34.1 %. No budget changes.

## Considered Options

- **Keep ADR-0064's CSS line boxes.** Kalamo's domain authority is Illustrator (ADR-0068). Point to Area would keep moving lines, and a set leading would stop being a fixed baseline distance.
- **An absolute `line-height` on the text.** Every box is still centred on its own family's em box, so a Noto run still rises above the strut.
- **Noto Sans SC first in `font-family`.** It moves Latin-only Area Type and replaces Source Sans 3's Latin glyphs.
- **Positioned lines or pinned tspans.** Inkscape ignores a line tspan's `y` when it draws (ADR-0068), and flowed text has no line positions to pin. Dropping `sodipodi:role` or `shape-inside` would lose Inkscape's line editing and the frame's wrapping.
- **Moving CJK up with `baseline-shift`.** It would move the glyphs, not the line box.

## Consequences

- `layoutText` has no `rise` or `drop`. Its line box is the first family's em box at the line's size and leading. `stack` gives each later baseline one leading below the one before, and `areaFrame` uses the same step.
- `drawing-conventions.md` no longer says CJK lines move on conversion, and says `leading` is the baseline distance in both kinds whatever fonts a line draws in.
- The inkscape fixture gains the "CJK Line Stacking" Artboard. The CJK and Korean Area Types' later lines move up, which changes the render golden and the export snapshot.
- Shaped Area Type's bands are unchanged. #200 moves them to per-line leading by this rule.
- Illustrator's top-to-top leading and Area Type Options' First Baseline stay out of scope.
