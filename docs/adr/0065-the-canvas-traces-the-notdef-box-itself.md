---
status: accepted
date: 2026-09-29
---

# The canvas traces the first face's `.notdef` outline for a character no bundled face has

A character that neither Source Sans 3 nor Noto Sans SC has, such as an emoji, Thai, Arabic, Devanagari or Hangul (until #164), draws in `render` and PNG export as the `.notdef` of the first family in the text's fallback order, because resvg has no system fonts. Bounds measure it at that `.notdef`'s advance (ADR-0063). The canvas set `ctx.font` to the bundled families only, but Canvas2D still falls back to any system font that has the glyph. So the canvas drew a real or colour glyph where `render` drew a box. A plain line, painted with one `fillText`, also moved every character after that glyph by the difference in advance, so the ink left the selection bounds (#165). This ADR amends the last Consequences bullet of ADR-0063.

## Decision

1. **One predicate.** `core` exports `hasGlyph(text, char)`: some face in the text's fallback order has the glyph, and a hard return needs none. `MISSING_GLYPHS` (ADR-0062) and the canvas both use it, so the warning and the drawing cannot disagree. When #164 adds a family to the table, its characters leave the missing set without any change here.
2. **The outline, from the font.** `scripts/font-metrics.mjs` also reads glyph 0 of each bundled face, from `glyf` for Source Sans 3 and from the `CFF ` charstring, run with its subroutines, for Noto Sans SC. It writes each outline as SVG path data in font units, `notdefPath`, next to the face's `notdef` advance. `notdefBox(text, x, y)` gives the first face's outline placed at a glyph origin, as segments. Source Sans 3's box has a cross inside it and differs by weight and slant. Noto Sans SC's box is 1000 units wide and the same in both weights. Measured with resvg-wasm 2.6.2 at 160 px, each traced outline matches resvg's own drawing of that face's `.notdef` pixel for pixel, in all eight faces.
3. **The canvas traces it and never asks a font for it.** `text()` in `render/canvas.ts` is the one path for Fill, Stroke, container paint copies and the text Clipping Path mask (ADR-0052). It fills or strokes the box with the paint already in force, in the character's own transform for baseline shift and rotation. A plain line with no missing character still paints in one `fillText` or `strokeText`, as before. A line with a missing character paints the characters around it in runs, each from its first glyph's origin as `glyphs` gives it, so the characters after the box stay at the positions bounds use. A run keeps ligatures and shaping within it, as the whole line did.

## Considered Options

- **A last-resort web font** whose cmap (format 13) maps every code point to a `.notdef` of the right advance, listed after the bundled families in `ctx.font`. It needs one generated font file per face, with its own licence and loading. It also depends on each browser's fallback order: Chromium may prefer a colour emoji font for emoji-presentation characters.
- **A plain rectangle** at the `.notdef` advance. It is simpler, but it is not what `render` draws. Source Sans 3's box has a cross, and its italic box is slanted.
- **Splitting the line in `layoutText`.** It would change what every caller of lines sees, for a need only the canvas has.

## Consequences

- The canvas, `render` and export now draw the same box for such a character, and its ink stays inside the bounds. The e2e test runs in the CI browser, where Playwright installs Noto Color Emoji. It records whether the browser has a system glyph for 😀, and it checks that no `fillText` or `strokeText` asks for 😀.
- A code point is one character, as in `core`. So an emoji built from several code points (a ZWJ sequence, a skin tone, a variation selector) draws one box per code point, as bounds measure it.
- The generated font tables grow by eight short path strings.
