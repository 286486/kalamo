---
status: accepted
date: 2026-09-29
---

# Export puts a space after a character in another bundled family in its own tspan

After a character Zibel draws in Noto Sans SC or Noto Sans KR, Inkscape drew the following space in that Noto face, 224 units wide (227 in Bold), where Zibel, resvg and the browser draw it in the text's first bundled family that has it, Source Sans 3 by default, 200 units wide. Every later word on an Inkscape line shifted by 0.024 em per such space, and Inkscape, which reflows Area Type itself (ADR-0022), could break a Korean paragraph at another place than Zibel (#170). This ADR amends ADR-0066's "worst region" consequence and ADR-0017's `text` row.

## Decision

**Zibel's model does not change.** A space draws in the first family in the text's fallback order that has it (ADR-0063, ADR-0066), in `core`, `render` and the canvas. This is Illustrator's model:

- An Illustrator composite font assigns fonts by character class: Kanji, Kana, Punctuation, Symbols, Roman ("the font used for half-width roman characters") and Numbers. U+0020 is half-width Roman, so it draws in the Roman font whatever comes before it. Zibel's fallback order has the same shape: Source Sans 3 is the Roman font, Noto Sans SC and Noto Sans KR the CJK classes. The ideographic space U+3000 is full-width and draws in a CJK font, as it does in Zibel.
- Without a composite font, Illustrator substitutes a font only for a glyph the text's font lacks, so a space the font has stays in it.
- Browsers match fonts per character (CSS Fonts), and resvg per chunk with `render`'s chunks (ADR-0063); both agree with Zibel.

Pango, and so Inkscape, is the renderer that differs. Pango 1.50.12's itemizer (`itemize.c`, `consider_as_space`) gives every `G_UNICODE_SPACE_SEPARATOR`, U+0020 and U+00A0 included, no font of its own: it joins the current item and takes the previous character's font, even when the next character is Latin. Pango's move of trailing spaces to a less-fallback font (its issue 249) fires only when `font_position < state->font_position`, and does not in Inkscape's layout: H → A and C → A measure 224.

**The export rule.** When `io` writes an SVG for Inkscape and browsers (not `render`'s chunked SVG for resvg), each run of U+0020 or U+00A0 that `core`'s `drawnFamily` draws in another bundled family than the last character before it on the same line that is not one of them is written as its own `<tspan>`, even with no attributes. Pango starts a new item at a span boundary, and an item holding only spaces takes the fontset's font for U+0020, the text's own family. So:

- The test is `drawnFamily`, the lookup that picks `render`'s chunk families, not a script test in `io`. The rule is "the family differs", not "the advance differs": in a `Noto Sans SC` text, a space after Hangul (Noto Sans KR) is split although both Noto spaces are 224 units.
- A space at the start of a line tspan needs no span: it is already in an item of its own.
- The span has no `x` or `y`, so it starts no text chunk. Export still writes one `<text>` per text and one line tspan per line, and names no Noto family in `font-family` (ADR-0063, ADR-0066).
- A space inside a Character Range keeps the range's attributes on its own span (ADR-0029), next to the range's other spans with the same attributes.
- A text whose spaces all follow characters of the space's own family gets no span, so a Latin-only Document exports byte for byte as before.
- Import reads a nested attribute-less tspan as plain text, and `canonicalRanges` drops runs with no overrides, so the span creates no Character Range and an exported Document reopens unchanged. The `io` tests check both for Point Type and Area Type.

## Evidence

Measured for #170 on `main@5e6f223`, and reproduced in its triage, with Inkscape 1.2.2 and Pango 1.50.12, `inkscape --query-width` on a 1000 px Source Sans 3 `<text xml:space="preserve">`, with the `fonts.conf` `fixtures/roundtrip.ts` writes (a stale pre-#164 one, with no Noto Sans KR accept, measures Hangul at 425.6 instead of 920). The added width of one space between two characters (A = `Z`, H = `한`, C = `小`), the same in Point Type and in Area Type (`shape-inside`):

| before → after | plain space | `<tspan> </tspan>` |
| --- | --- | --- |
| H → H, H → C, H → A | 224 | **200** |
| C → H, C → C, C → A | 224 (227 Bold) | **200** (Bold too) |
| A → H, A → C | 200 | 200 |
| H → H, Bold | 227 | 200 |
| H → H, two spaces | 448 | 400 |
| H → H, U+00A0 | 224 | 200 |
| any, U+3000 | 1000 | 1000 (Zibel draws it in Noto too) |
| U+2060 word joiner before the space | 224 | – |

Without `xml:space="preserve"`, which Zibel already writes, a whitespace-only `<tspan>` collapses to nothing.

**Area Type line breaks.** Inkscape's saved file writes flowed text as one positioned tspan per line it laid out, so a save shows where Inkscape breaks. For the fixture's Korean Area Type (14 pt, 90 pt wide), the code-point offset each Inkscape line starts at equals `layoutText`'s `start`: `[0, 8, 16, 25, 36]`, with and without the spans. The same text at every width from 60 to 198 pt in 3 pt steps (47 widths) breaks at Zibel's offsets in every case with the spans. With them stripped from the same export, as before this ADR, 5 of the 47 break elsewhere:

| width | Zibel | plain spaces |
| --- | --- | --- |
| 87 | `[0, 8, 16, 25, 36]` | `[0, 8, 16, 25, 35]` |
| 96 | `[0, 9, 19, 30, 38]` | `[0, 8, 16, 25, 36]` |
| 138 | `[0, 13, 25]` | `[0, 12, 25]` |
| 186 | `[0, 17, 38]` | `[0, 17, 37]` |
| 192 | `[0, 19]` | `[0, 17, 38]` |

**After an Inkscape save.** Inkscape keeps the nested span in Point Type, and its re-saved file still measures 200. In Area Type it rewrites the flowed text as one positioned tspan per line and drops the span, so Inkscape drawing its own saved file measures 224 again. Zibel's import of Area Type ignores tspans and recomputes the layout (ADR-0022), so its next export writes the span back.

## Round trip

Every region's score in each `pnpm roundtrip` case, before this ADR (`main@5e6f223`, the same run with `write.ts` reverted) → after. A region `–` is not drawn in that case. Only the two marked regions change; none scores higher. Pixel budgets do not change.

| region | no edit | rotate+scale | flip |
| --- | --- | --- | --- |
| Artboard 1 vector | 0.09% | 0.09% | 0.09% |
| Artboard 2 vector | 0.01% | 0.01% | 0.01% |
| Images vector | 0% | 0% | 0% |
| Stars vector | 0.35% | 0.35% | 0.35% |
| Arcs vector | 0.03% | 0.03% | 0.03% |
| Gradients vector | 0% | 0% | 0% |
| Type vector | 0% | 0% | 0% |
| Characters vector | 0% | 0% | 0% |
| Containers vector | 0.02% | 0.03% | 0.02% |
| Clipping Paths vector | 0.06% | 0.06% | 0.06% |
| Text Clipping vector | 0% | 0% | 0% |
| Layer Clipping vector | 0% | 0% | 0% |
| Spirals vector | 0.22% | 0.22% | 0.22% |
| CJK vector | 0% | 0% | 0% |
| CJK Area Type vector | 0% | 0% | 0% |
| Korean vector | 0% | 0% | 0% |
| outside Artboards vector | 0% | 0% | 0% |
| Artboard 1 `Flowed in a box ` | 2.43% | 2.43% | 2.43% |
| outside Artboards `Flowed in a box ` | 0% | 0% | 0% |
| Characters `LITTLE` | 0% | 0% | 0% |
| Containers `Area type wraps ` | 7.25% | 5.28% | 7.25% |
| Type `Italic` | 6.93% | 6.93% | 6.93% |
| Images `Native` | 0% | 0% | 0% |
| Images `01M38T29SQCR0PPE` | 0% | 0% | 0% |
| Type `Bold` | 0% | 0% | 0% |
| Images `01M38T29SQ1MAGEH` | 0% | 0% | 0% |
| Type `Black` | 0.41% | 0.41% | 0.41% |
| Characters `Spin` | 0.25% | 0.25% | 0.25% |
| Containers `Field` | 0% | 0% | 0% |
| Gradients `Grad` | 0% | 0% | 0% |
| Type `Black Italic` | 4.38% | 4.38% | 4.38% |
| Characters `Tracked area typ` | 4.1% | 4.1% | 4.1% |
| Type `Bold Italic wrap` | 6.75% | 6.75% | 6.75% |
| Containers `Paint` | 3.74% | 0.21% | 3.74% |
| outside Artboards `Paint` | 0% | 2.96% | 0% |
| Text Clipping `TYPE MASK hidden` | 2.77% | 2.77% | 2.77% |
| Korean `한국어 문장은 음절 사이에서 ` | 8.73% → **0.63%** | 8.73% | 8.73% |
| CJK Area Type `Zibel用SVG保存「矢量图」` | 1.1% | 1.1% | 1.1% |
| outside Artboards `Point Type` | 8.69% | 8.69% | 8.69% |
| Korean `Hi 直骨한국` | 0.53% | 0.53% | 0.53% |
| CJK `Hi 你好，世界。` | 0.68% | 0.68% | 0.68% |
| Artboard 1 `Round & trip` | 5.86% | 5.86% | 5.86% |
| Layer Clipping `ZIB` | 0% | 0% | 0% |
| outside Artboards `Round & trip` | 0% | 0% | 0% |
| Korean `Bold 한글` | 0.91% | 0.91% | 0.91% |
| CJK `Bold 小动物 Zibel` | 4.34% → **0.31%** | 4.34% → **0.31%** | 4.34% → **0.31%** |
| Text Clipping `Zibel` | 0.21% | 0.21% | 0.21% |
| Characters `Paint` | – | 0.38% | – |
| Layer Clipping `Paint` | – | 1.12% | – |

- **No edit.** Inkscape draws Zibel's export. The Korean Area Type falls from 8.73% to 0.63% and `Bold 小动物 Zibel` from 4.34% to 0.31%. The worst region is `Point Type` again (8.69%, unchanged), as before ADR-0066.
- **rotate+scale and flip.** Inkscape edits the export, saves it, and draws its own saved file. `Bold 小动物 Zibel` is Point Type, whose span Inkscape keeps: 0.31%. The Korean Area Type stays at 8.73%: Inkscape's save rewrites flowed text and drops the span (above), so it draws its own file with the 224-unit spaces. The residual is that save, not Zibel's export; making Inkscape keep the span is out of scope. The structural check, which compares the shown lines Inkscape saves with the export's, passes in both cases: Inkscape laid the export out at Zibel's breaks before it saved, as it also did without the spans at the fixture's 90 pt width.

## Considered Options

- **Follow Pango in Zibel.** It diverges from Illustrator's composite-font Roman class and from the browser, needs the canvas to paint spaces run by run, and changes the layout of every existing CJK Document in `core`, `render`'s chunks and the canvas.
- **`dx` or `word-spacing` corrections on the spaces.** They write positional or style data that Inkscape keeps and Zibel's import would have to interpret or warn about, and they hard-code the 24- or 27-unit difference per face.
- **An explicit `x` per word.** Each word becomes a text chunk, which breaks editing in Inkscape and flowing in Area Type (ADR-0063 keeps one chunk per line).
- **Accepting the divergence.** Korean puts a space between words, so almost every Korean line drifts in Inkscape, and Area Type can wrap differently, as the width scan shows.

## Consequences

- Inkscape draws a Korean or Chinese line's words where Zibel does, and wraps Area Type at Zibel's offsets, from Zibel's export. Its own re-save of Area Type loses the spans until Zibel exports it again.
- Other space separators (U+2000–U+200A, U+202F, U+205F) keep Pango's behaviour: no bundled font shows a divergence the fixture measures. They join the rule if a measurement shows one. Pango's trailing-space move, should a later Pango enable it here, is not emulated.
- #67 (per-range font family) changes which family a character draws in; the rule reads `drawnFamily`, so it follows.
