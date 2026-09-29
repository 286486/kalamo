---
status: accepted
date: 2026-09-23
---

# Point Type is a `text` Node in one bundled font, measured by advance widths from a generated table

An Agent creates Point Type (F-TEXT-01) with `node_create` `{type: "text", x, y, content, fontSize, appearance}`. The Node stores `kind: "point"`, `x`, `y`, `content`, `fontFamily` and `fontSize` flat, beside the usual Appearance, and it looks the same in `render` and in the browser:

- **Anchor.** `x, y` is where the baseline of the first character starts, the point Illustrator's Type tool clicks. SVG's `<text x y>` and Canvas2D's default `textBaseline = "alphabetic"` both put the baseline there, so the two renderers agree without an offset.
- **Content.** `content` is one line of plain text, 1 to 10 000 characters, no line breaks, tabs or other control characters: Point Type breaks lines only at a hard return, and neither a return nor a tab is laid out yet (ADR-0022 lets `content` hold hard returns). It is stored as a string with the character attributes (`fontFamily`, `fontSize`) on the Node, as Figma stores `characters` with Node-level style. The runs of REQUIREMENTS §6.5 (`content: [{text, style}]`) arrive with F-TEXT-02 as style overrides on ranges of that string (ADR-0029: `tracking` and Character Ranges), so a Node with one run never needs migrating; a runs input then compiles to this shape.
- **Font.** One font ships: Source Sans 3 Regular (Adobe, SIL OFL 1.1), the open counterpart of Myriad, Illustrator's default typeface. `fontFamily` is `"Source Sans 3"`, the only value it accepts until F-TEXT-02 loads others (ADR-0028 adds `fontStyle` and five more faces); `fontSize` defaults to Illustrator's 12 pt. The TTF ships unmodified (the OFL reserves the name "Source" for modified versions, so no subset), with its licence, under `packages/render/fonts/`. The Worker passes its bytes to resvg with system fonts off. The browser loads the same file as a `FontFace` and redraws once it has loaded.
- **Appearance.** Illustrator's default for new type: a black Fill and no Stroke. Fills and Strokes stack as on any leaf: in SVG one `<text>` per Fill, then one per Stroke with `fill="none"` (ADR-0017: a single Fill and Stroke become one element); on the canvas one `fillText` per Fill, then one `strokeText` per Stroke.
- **Bounds.** The geometric bounds are the text box: from `x` for the sum of the characters' advance widths, and from the font's ascender above the baseline to its descender below, each scaled by `fontSize / unitsPerEm`, then mapped through the Node's `transform` like any leaf. A character the font lacks counts the advance of `.notdef`. The advances, `unitsPerEm`, ascender and descender come from a TypeScript table in `core` that a committed script generates from the TTF, so bounds stay synchronous in the Durable Object, the Worker and the browser without shipping or parsing the font in `core`.
- **No shaping.** Both renderers turn kerning off (`style="font-kerning:none"` in SVG, which resvg honours only as a style; `ctx.fontKerning = "none"` on the canvas), so the drawn width is the advance sum the bounds report. HarfBuzz (F-TEXT-09, M1) replaces the advance sum with shaped glyph positions and turns kerning back on in all three places at once.
- **Editing.** `node_update` writes `content`, `fontSize`, `x` and `y` through the same per-type schema as a Live Shape's parameters. `node_get` `full` returns the stored properties and bounds but no `d`: a text Node has no outline until Create Outlines (F-TEXT-06).
- **Browser.** A text Node is hit anywhere inside its bounds, and its auto-name in the Layers panel is its content (ADR-0012).

## Considered Options

- **Storing `content` as runs now**: matches §6.5's shape, but every reader would unwrap a one-element array, and a range-override model (Figma's) grows into rich text without changing single-run Nodes.
- **Parsing the TTF at runtime in `core`**: one source of truth, but `bounds` is synchronous and runs in three places; the Durable Object and the browser would each need the font bytes and an async load before the first bounds.
- **Keeping kerning on in the renderers**: Illustrator's default is Auto kerning, but then pixels and bounds disagree until HarfBuzz lands; turning it off keeps `render`, the canvas and the reported bounds the same.
- **Inter or Noto Sans**: both OFL; Source Sans 3 is the closest to Illustrator's default look.

## Consequences

- The Worker bundle grows by the 431 KB TTF. Nothing subsets it: a subset would be a modified version and must drop the name "Source".
- Characters outside the font (CJK, emoji) render as `.notdef` boxes and measure as its advance, and the receipt warns `MISSING_GLYPHS` (ADR-0062); missing fonts are F-TEXT-11. Amended by ADR-0063: Noto Sans SC is bundled, and a character Source Sans 3 lacks draws and measures in it.
- Ligatures still apply in both renderers, so "fi" can draw narrower than its bounds by a fraction of a character until HarfBuzz.
- A `text` Node has no `d`, so it is not a Live Shape and not in `shapeSegments`; code that walks leaves handles it as its own case.
