---
status: accepted
date: 2026-09-29
---

# Character Ranges override stroke, tracking, font style, family and size too

ADR-0029 let a Character Range override `fill`, `baselineShift` and `rotation`, and left the rest of Illustrator's Character panel on the Node. An Inkscape file that sets any other character attribute on part of a text imported it in the text's own value, with `UNSUPPORTED_ATTRIBUTE` (#67). Per #24 that is a Kalamo gap to close. Illustrator's Character panel sets every one of these per character, and Inkscape writes them on tspans inside a line. This ADR amends ADR-0029's model, layout, drawing and import sections, and ADR-0028's "the style of a range arrives with runs".

## The model

A Character Range is `{start, end, fill?, stroke?, baselineShift?, rotation?}`, as ADR-0029 describes it, plus the overrides below. The later range still wins attribute by attribute, and ranges are still stored sorted, not overlapping, and with adjacent equal runs merged.

- **`stroke`** is a colour, `#RRGGBB` or `#RRGGBBAA`, parsed as range `fill` is. For these characters it replaces the paint of every Stroke in the text's Appearance. The Stroke's width, dash and joins do not change. A text with no Stroke draws none, whatever its ranges say. The name mirrors range `fill` and Illustrator's character stroke colour. A text that becomes a Clipping Path loses its range strokes with its range fills (ADR-0052, `unfilledRanges`).
- **`tracking`** is in thousandths of an em, from −1000 to 10 000, the Node's bounds (ADR-0029). A character's added space is its tracking × its own font size / 1000, so a range that also sets `fontSize` tracks in its own em, as Illustrator's does. Each character tracks by its own value: a line's width is the sum of its characters' advances and trackings, minus the tracking of its last character, which is not drawn (ADR-0029). Area Type wraps, and Point Type measures its bounds, by that width.
- **`fontStyle`** is one of ADR-0028's 18 style names. Each of these characters advances and draws in its own style's matched bundled face, by the CSS matching of ADR-0028, in whichever bundled family it draws in (ADR-0063). A style that is not bundled warns `FONT_MISSING` as the Node's does, naming the face drawn, once per distinct missing face per text. A Node's `fontStyle` is the default a range overrides, as ADR-0028 planned for runs.

**An override equal to the Node's own value is no override.** For the overrides that repeat a Node attribute (tracking, font style, family and size, below), `canonicalRanges` drops a value equal to the Node's, as it drops a `baselineShift` or `rotation` of 0. So a later range can clear an earlier one by writing the Node's value, and every stored override changes what is drawn. It is dropped against the Node's attributes after the write, so a `node_update` that sets the Node's `fontSize` to a range's `fontSize` also removes that range's override. A `fill` or `stroke` equal to the text's own solid paint is still kept, as ADR-0029 keeps it: the Node has no single colour to compare it with, since its Appearance can hold several paints.

## Drawing

- **SVG.** A run's nested `<tspan>` carries `stroke`, with `stroke-opacity` for an `#RRGGBBAA` colour, only in the elements that paint a Stroke, never in a Fill's element or a container paint's copy (ADR-0043). An opaque range stroke writes `stroke-opacity="1"` where the element's own Stroke is translucent, since `stroke-opacity` inherits. A painted text Clipping Path writes its range strokes in the copy that paints its Strokes (ADR-0051), and import reads them back from there.
- **SVG.** A run's nested `<tspan>` carries its style as the `font-weight` and `font-style` that differ from its text's, so a Regular run in a Bold text writes `font-weight="400"`. Inkscape and resvg match them to the bundled faces as Kalamo does.
- **SVG.** A run's nested `<tspan>` carries its tracking as `letter-spacing` in user units, as the `<text>` does. SVG adds a character's `letter-spacing` after it, so a run's space is its own, as in Kalamo.
- **Canvas.** The per-character path of ADR-0029 sets `ctx.font` to each character's own face, places each character after the one before by that one's tracking, and strokes each character in its range's stroke colour. A container Stroke still paints every glyph in its own colour.

## SVG import

- Each character's computed `font-weight` and `font-style` become its style name, as the text's do (ADR-0028), and a style different from the Node's is a range `fontStyle`.
- Each character's computed `letter-spacing` becomes its tracking, in thousandths of its font size, as the text's does (ADR-0029), and a tracking different from the Node's is a range `tracking`. A baked scale scales the spacing and the font size alike, so it needs no scaling. A second line tspan's own `letter-spacing` now imports too, where it was dropped.
- A tspan's solid `stroke`, or a different `stroke-opacity`, that differs from the text's own Stroke becomes a range `stroke`, as a tspan `fill` becomes a range `fill`.
- These still warn `UNSUPPORTED_ATTRIBUTE` and import as the text's own paint: a tspan `stroke` that is a gradient or `none`, any `stroke` on a text with no Stroke (`stroke` `none`, or `stroke-width` 0), and a tspan `stroke-width`, `stroke-dasharray`, `stroke-linecap`, `stroke-linejoin` or `stroke-miterlimit` that differs from its line's.

## Evidence

Inkscape 1.2.2, headless, with the round trip's `fonts.conf`: `--query-all` on "Spaced out" at 16 pt with `letter-spacing` 0.8 on the `<text>`, 4.8 on a tspan around "Spaced" and −1.28 on one around "out" puts the space at x = 88.4 from 10 and "out" 24 later and "X" after it 17.76 later than without the tspans: 6 × (4.8 − 0.8) and 24 + 3 × (−1.28 − 0.8). `layoutText` gives the same origins, and resvg moves the "X" by 17.75 px at 4 px per pt. So both apply a tspan's spacing after each of its characters, and at the end of a tspan, before the next.

In `pnpm roundtrip`, the fixture's Point Type "Spaced out" differs by 6.7 % of its region and its tracked Area Type by 1.4 %, against the 15 % text budget. The Area Type breaks where Kalamo does. "Mix Bold, Italic and Black", with a range in each of three styles, differs by 3.2 %. The Point Type's glyphs land within a pixel of each other in the two renderers; that is antialiasing at fractional positions, since both use the same origins.

## Considered Options

- **`strokeColor`**, or a whole Stroke per range. Illustrator's character stroke also has its own weight, but a range width, dash or join is out of scope for #67, and `stroke` next to `fill` reads as the pair SVG and Illustrator show.
- **Tracking in the Node's em**, so a range tracking stays the same length when the range's size changes. Illustrator's tracking is in the character's own em, and SVG's `letter-spacing` on a resized tspan is a length the writer must convert anyway.
- **Dropping a `fill` or `stroke` equal to the Node's paint.** A text can have several Fills and Strokes, and a gradient one, so "the Node's colour" is not defined.

## Consequences

- MCP: `node_create` and `node_update` take the new keys in `ranges`, and `node_get` `full` returns them. `.kalamo.json` and stored Nodes need no migration: the new keys are optional.
- The round-trip fixture has a Character Ranges Artboard with a text for each new override.
