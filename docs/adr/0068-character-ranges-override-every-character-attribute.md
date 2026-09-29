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
- **`fontFamily`** is any font name, kept and exported as written, as the Node's is (F-TEXT-11). These characters draw in its fallback order (ADR-0063): the family itself if bundled, else Source Sans 3, then the other bundled families. #67 said a range family would not change layout, since one family was bundled when it was written. Since ADR-0063 and ADR-0066 three are, so a range naming Noto Sans SC measures and draws its Latin in Noto Sans SC, as a text in that family does, and an Area Type line holding it stacks by Noto's em box (ADR-0064). A range naming an unbundled family lays out as the text's own characters do when the text's family is Source Sans 3. A family or style that is not bundled warns `FONT_MISSING` as the Node's does.
- **`fontSize`** is in pt and positive, as the Node's. A character's advance, its cell from ascender to descender, and its tracking scale with its own size. Point Type's box grows to hold each character's cell, so a 24 pt range on a 12 pt text reaches the 24 pt ascender. A Node `fontSize` write does not rescale range sizes, and a whole-`content` write still clears the ranges.

**An override equal to the Node's own value is no override.** For the overrides that repeat a Node attribute (tracking, font style, family and size, below), `canonicalRanges` drops a value equal to the Node's, as it drops a `baselineShift` or `rotation` of 0. So a later range can clear an earlier one by writing the Node's value, and every stored override changes what is drawn. It is dropped against the Node's attributes after the write, so a `node_update` that sets the Node's `fontSize` to a range's `fontSize` also removes that range's override. A `fill` or `stroke` equal to the text's own solid paint is still kept, as ADR-0029 keeps it: the Node has no single colour to compare it with, since its Appearance can hold several paints.

## Lines follow Illustrator's leading

Illustrator's leading belongs to a line: it is that line's baseline's distance below the previous line's. Auto leading is 120 % of the largest font size on the line. An explicit Node `leading` stays fixed for every line, whatever sizes the line holds. Kalamo lays lines out this way:

- **Point Type.** The first baseline stays at `y`. Each later baseline is its line's leading below the one before. A line's largest size counts every character on it, its hard return included, so a range size on an empty line's return sets that line's leading. An empty last line takes the Node's size. A 24 pt range on a line of a 12 pt Auto text puts that line 28.8 pt below the one before, and the next line 14.4 pt below it.
- **Area Type.** Wrapping is by width, as before. Then each line takes its leading from its own largest size. The first baseline is ADR-0022's, at that line's size and leading: `y + (leading − size) / 2 + size · ascender / (ascender − descender)`. Each later baseline is the line's leading below the one before, plus what a line holding CJK adds (ADR-0064, with its boxes at the line's size and leading). The fit tests of ADR-0022 and ADR-0064 read the line's own leading: a later line shows while 90 % of its leading lies in the frame, measured from its top.
- A text whose ranges set no `fontSize` lays out exactly as before, byte for byte in the SVG export.

**Inkscape does not follow this.** It lays out `sodipodi:role="line"` tspans, and flowed text, with CSS line boxes (ADR-0064): each inline box is 1.2 × its own size tall around its em box, and a baseline sits the previous line's descent plus its own ascent below the one before. Inkscape ignores a line tspan's written `y` when it draws, and keeps it as written on save. Kalamo still writes each line's `y` as laid out here, so resvg, browsers and any reader that honours `y` draw Illustrator's lines. A mixed-size text reads back field for field, since import takes `leading` from `line-height`, not from line positions. Only its pixels in Inkscape differ, and by how much is measured below.

## Drawing

- **SVG.** A run's nested `<tspan>` carries `stroke`, with `stroke-opacity` for an `#RRGGBBAA` colour, only in the elements that paint a Stroke, never in a Fill's element or a container paint's copy (ADR-0043). An opaque range stroke writes `stroke-opacity="1"` where the element's own Stroke is translucent, since `stroke-opacity` inherits. A painted text Clipping Path writes its range strokes in the copy that paints its Strokes (ADR-0051), and import reads them back from there.
- **SVG.** A run's nested `<tspan>` carries its `font-family` as written. `render`'s chunked SVG for resvg writes, instead, the bundled family each chunk draws in, by the character's own fallback order, and starts a chunk where it changes (ADR-0063). The space rule of ADR-0067 compares the families characters draw in by their own fonts.
- **SVG.** A run's nested `<tspan>` carries its style as the `font-weight` and `font-style` that differ from its text's, so a Regular run in a Bold text writes `font-weight="400"`. Inkscape and resvg match them to the bundled faces as Kalamo does.
- **SVG.** A run's nested `<tspan>` carries its tracking as `letter-spacing` in user units, as the `<text>` does. SVG adds a character's `letter-spacing` after it, so a run's space is its own, as in Kalamo.
- **SVG.** A run's nested `<tspan>` carries its `font-size` in user units, one per pt. `letter-spacing` is a length, so a run whose size differs from the Node's writes its own `letter-spacing` whenever its tracking is not zero, even when the tracking is the Node's.
- **Canvas.** The per-character path of ADR-0029 sets `ctx.font` to each character's own face, places each character after the one before by that one's tracking, and strokes each character in its range's stroke colour. A container Stroke still paints every glyph in its own colour.

## SVG import

- Each character's computed `font-family`, its first name unquoted, becomes its family, and one different from the Node's is a range `fontFamily`.
- Each character's computed `font-weight` and `font-style` become its style name, as the text's do (ADR-0028), and a style different from the Node's is a range `fontStyle`.
- Each character's computed `letter-spacing` becomes its tracking, in thousandths of its font size, as the text's does (ADR-0029), and a tracking different from the Node's is a range `tracking`. A baked scale scales the spacing and the font size alike, so it needs no scaling. A second line tspan's own `letter-spacing` now imports too, where it was dropped.
- Each character's computed `font-size` becomes its size, and one different from the Node's is a range `fontSize`. A baked scale scales it. Percentages and `em` resolve against the parent's computed size, and its `letter-spacing` converts to tracking by the character's own size. A keyword size (`larger`, `small`, …) still warns `UNSUPPORTED_ATTRIBUTE` and imports in the text's size.
- A tspan's solid `stroke`, or a different `stroke-opacity`, that differs from the text's own Stroke becomes a range `stroke`, as a tspan `fill` becomes a range `fill`.
- These still warn `UNSUPPORTED_ATTRIBUTE` and import as the text's own paint: a tspan `stroke` that is a gradient or `none`, any `stroke` on a text with no Stroke (`stroke` `none`, or `stroke-width` 0), and a tspan `stroke-width`, `stroke-dasharray`, `stroke-linecap`, `stroke-linejoin` or `stroke-miterlimit` that differs from its line's.

## Evidence

Inkscape 1.2.2, headless, with the round trip's `fonts.conf`: `--query-all` on "Spaced out" at 16 pt with `letter-spacing` 0.8 on the `<text>`, 4.8 on a tspan around "Spaced" and −1.28 on one around "out" puts the space at x = 88.4 from 10 and "out" 24 later and "X" after it 17.76 later than without the tspans: 6 × (4.8 − 0.8) and 24 + 3 × (−1.28 − 0.8). `layoutText` gives the same origins, and resvg moves the "X" by 17.75 px at 4 px per pt. So both apply a tspan's spacing after each of its characters, and at the end of a tspan, before the next.

In `pnpm roundtrip`, the fixture's Point Type "Spaced out" differs by 6.7 % of its region and its tracked Area Type by 1.4 %, against the 15 % text budget. The Area Type breaks where Kalamo does. "Mix Bold, Italic and Black", with a range in each of three styles, differs by 3.2 %. "Sans and Noto 你好", with Latin and Chinese ranges in Noto Sans SC, differs by 7.0 %, and an Area Type whose middle words are in Noto Sans SC by 4.4 %, its three lines where Kalamo stacks them. The Point Type's glyphs land within a pixel of each other in the two renderers; that is antialiasing at fractional positions, since both use the same origins.

Inkscape 1.2.2, headless, `--query-all` on "H" probes, 12 pt Source Sans 3 with `line-height: 1.2` and one 24 pt "B". The table gives the three baselines. The Illustrator values are Kalamo's.

| Text | Inkscape | Illustrator |
|---|---|---|
| Point Type, `HH` / `HBH` / `HH`, Auto | 50, 74.65, 93.2 | 50, 78.8, 93.2 |
| Point Type, `HBH` / `HH` / `HH`, Auto | 50, 68.55, 82.95 | 50, 64.4, 78.8 |
| Point Type, `HH` / `HBH` / `HH`, leading 14.4 | 50, 67.45, 81.85 | 50, 64.4, 78.8 |
| Area Type from y = 40, `HH` / `HBH` / `HH`, Auto | 50.25, 74.9, 93.45 | 50.25, 79.05, 93.45 |
| Area Type from y = 40, `HBH` / `HH` / `HH`, Auto | 60.5, 79.05, 93.45 | 60.5, 74.9, 89.3 |

The Point Type file wrote `y="78.8"` on its second line. Inkscape drew that line at 74.65 and saved `y="78.8"` unchanged. So a line that holds a larger size lands up to about 4 pt from Illustrator's position in Inkscape, and the lines after it shift by the same amount. The first line of either kind, and a line of the text's own size after lines of the same size, agree.

In `pnpm roundtrip`, two of the fixture's three mixed-size texts do not stay inside the 15 % text budget. The Point Type "Heading word / body text here / last line", with a 24 pt and an 18 pt range, differs by 14.0 %, inside it. The Point Type "fixed / LEADING / lines", with a 22 pt line at a 16 pt leading, differs by 20.8 %. The 11 pt Area Type with a 20 pt word differs by 19.0 %. Its lines break where Kalamo breaks them, and the same lines show. The round trip gives a text region whose lines can differ in size, a multi-line Point Type or an Area Type with a range `fontSize`, its own `mixed-size text` budget of 25 %. The 15 % budget still covers every other text, and the structure check still covers them all. Texts on one line, or of one size, are unaffected.

## Considered Options

- **Inkscape's CSS line boxes**, as ADR-0064 chose for CJK. That model keeps the round trip inside 15 %, but Kalamo's domain authority is Illustrator: an explicit leading would stop being a fixed baseline distance, and a heading's line would sit by its own descent and ascent, not by its leading. Inkscape is the interchange editor, so its difference is measured and bounded, not adopted.
- **Forcing Inkscape's positions**: writing line tspans without `sodipodi:role="line"`, so Inkscape honours each `y`, or per-line `line-height` values that make its line boxes land on Illustrator's baselines. The first loses Inkscape's line editing and the second has no solution in general, since a line's descent feeds the next line's distance, and flowed Area Type has no per-line positions at all.

- **`strokeColor`**, or a whole Stroke per range. Illustrator's character stroke also has its own weight, but a range width, dash or join is out of scope for #67, and `stroke` next to `fill` reads as the pair SVG and Illustrator show.
- **Tracking in the Node's em**, so a range tracking stays the same length when the range's size changes. Illustrator's tracking is in the character's own em, and SVG's `letter-spacing` on a resized tspan is a length the writer must convert anyway.
- **Dropping a `fill` or `stroke` equal to the Node's paint.** A text can have several Fills and Strokes, and a gradient one, so "the Node's colour" is not defined.

## Consequences

- MCP: `node_create` and `node_update` take the new keys in `ranges`, and `node_get` `full` returns them. `.kalamo.json` and stored Nodes need no migration: the new keys are optional.
- The round-trip fixture has a Character Ranges Artboard with a text for each new override.
- `pnpm roundtrip` budgets mixed-size text regions at 25 %, above the 20.8 % measured. A regression in line stacking beyond Inkscape's model difference still fails it, as does any change to a text of one size.
