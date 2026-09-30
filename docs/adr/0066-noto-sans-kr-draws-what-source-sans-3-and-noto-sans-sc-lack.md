---
status: accepted
date: 2026-09-29
---

# Noto Sans KR is bundled as a third family, after Noto Sans SC in the fallback order

ADR-0063 bundled Noto Sans SC for the characters Source Sans 3 lacks. Noto Sans SC has no Hangul, so Korean still drew `.notdef` boxes in `render`, PNG and SVG export and text Clipping Paths, measured each syllable at the `.notdef` advance, wrapped Area Type by that advance and warned `MISSING_GLYPHS`. The browser drew Hangul in whatever system Korean font it had, so the canvas, `render` and the bounds disagreed (#164). This ADR amends ADR-0063's `MISSING_GLYPHS` message and "No Hangul" consequence, ADR-0064's Korean consequence, ADR-0065's list of missing scripts and ADR-0017's pixel-check paragraph.

## Decision

1. **The face.** Noto Sans KR from `notofonts/noto-cjk`, `Sans/SubsetOTF/KR/`, in two faces: `NotoSansKR-Regular.otf` (4,644,748 B) and `NotoSansKR-Bold.otf` (4,816,044 B). Both ship unmodified in `packages/render/fonts/` with their SIL OFL 1.1 text in `LICENSE-NotoSansKR.txt`, which is byte-identical to Noto Sans SC's. Noto declares no Reserved Font Name. Each face covers the same 23,174 code points: the 11,172 Hangul syllables, jamo, 8,138 CJK Unified Ideographs (Hanja, in Korean forms), Latin and punctuation. Style matching is Noto Sans SC's: weights to 500 draw in Regular, heavier ones in Bold, and an italic text's Hangul draws upright in all three renderers.
2. **Fallback order.** A text's own family comes first if it is bundled, else Source Sans 3. Then come the other bundled families in the order Source Sans 3, Noto Sans SC, Noto Sans KR. Hanja and kana in a Source Sans 3 text keep drawing in Noto Sans SC, exactly as ADR-0063 draws them. Only what neither Source Sans 3 nor Noto Sans SC has falls to Noto Sans KR, which in practice means Hangul. `"Noto Sans KR"` is a bundled family: a text set in it draws everything the family has in it, including its Latin and its Hanja in Korean forms, and does not warn `FONT_MISSING`.
3. **One list of bundled families.** `FAMILIES` in `core/src/text.ts` is the only table that names them, and its key order is the fallback order. `BUNDLED_FAMILIES` lists its keys. `BUNDLED_FAMILIES_NOTE` is built from the families and the scripts each one draws ("Source Sans 3 (Latin, Greek, and Cyrillic), Noto Sans SC (Chinese and Japanese), and Noto Sans KR (Korean) are bundled; each character draws in the text's own family if bundled and it has the glyph, else in the first of them that has it"), and the `fontFamily` schema description and the `node_create` tool description use it. The `MISSING_GLYPHS` message is built from the families too: `None of Source Sans 3, Noto Sans SC, or Noto Sans KR has glyphs for 😀; …`. The font files cannot live in `core`, so `render` (`LAZY_FONTS` in `png.ts`) and `apps/web` (`FONT_FILES` in `fonts.ts`) each import them keyed by family name, typed as a `Record` over `BundledFamily`. A test in each package fails if the keys differ from `BUNDLED_FAMILIES`. Outside those two maps, no source file in `core`, `render`, `io`, `mcp` or `apps/web` names a Noto family. Tests and `drawing-conventions.md`, which is prose, are the exceptions.
4. **Each family but Source Sans 3 loads on its own, only where it is drawn.** `render` keeps one memoised load per family. A render copies a family's files into resvg only when its SVG names that family, which `render`'s SVG does on every chunk drawn in it (ADR-0063). So a Hangul-only render copies Noto Sans KR and not Noto Sans SC, and a Latin-only render copies neither. The browser loads Source Sans 3 with the page and each other family the first time the open Document draws a character in it (`characterFamilies`, a Character Range's font included), so a Chinese-only Document never requests Noto Sans KR. Each file is fetched once and registered upright and italic.
5. **Metrics.** `font-metrics.mjs` writes `core/src/noto-sans-kr.ts` in `noto-sans-sc.ts`'s format, from the same parser: each face's `.notdef` advance and outline, its advances as runs, and the OS/2 typographic ascender and descender. Those are 880 and −120, the same as Noto Sans SC's, so a Hangul run exports the same `line-height` as a Han run, and its line stacks by leading alone (ADR-0080). Every Hangul syllable is 920 units wide in both faces. Han is 1000.

## Round trip

The Inkscape fixture gains a "Korean" Artboard with three texts. `Hi 直骨한국` is Regular Point Type. Its 直 and 骨 have distinct Simplified Chinese and Korean forms, so the region shows which face Inkscape picked for Han. `Bold 한글` is Bold Point Type. The third is a 14 pt Korean Area Type, 90 pt wide, with spaces between words. `pnpm roundtrip` now prints every region's score after each case line, so a run can be compared with a baseline region by region.

| region | `main@5cc7af9` | this ADR | without the Noto Sans SC preference | without the Noto Sans KR accept |
| --- | --- | --- | --- | --- |
| Korean `Hi 直骨한국` | – | 0.53% | 6.23% | 9.18% |
| Korean `Bold 한글` | – | 0.91% | 0.91% | **15.41% FAIL** |
| Korean Area Type | – | 8.73% | 8.73% | **22.48% FAIL**, and its shown lines differ |
| CJK `Hi 你好，世界。` | 0.68% | 0.68% | 3.34% | 0.68% |
| CJK `Bold 小动物 Kalamo` | 4.34% | 4.34% | 4.34% | 4.34% |
| CJK Area Type | 1.1% | 1.1% | 1.81% | 1.1% |
| outside Artboards `Point Type` | 8.69% | 8.69% | 8.69% | 8.69% |

The three Inkscape cases score the same. Every other region is unchanged, and the Document reopens unchanged. Export still writes one `<text>` per line, with no chunk split.

- **Accept by path.** The generated `fonts.conf` accepts the four bundled Noto files by absolute `file` path and still rejects every `zh-cn`, `zh-tw`, `ja` and `ko` font. The round-trip script throws if a listed file is missing. Without the Noto Sans KR accept, the `ko` reject also removes the bundled files, and Hangul draws in no font.
- **Han stays in Noto Sans SC.** Both Noto families cover Han, and fontconfig's sort, which ranks by its own criteria and not by Kalamo's order, ranked Noto Sans KR first for a Source Sans 3 text's ideographs. A `<match target="pattern">` appends `Noto Sans SC` and then `Noto Sans KR` to every pattern's family list, weakly, so Noto Sans SC ranks first. The control column shows the Han regions moving without it.
- **Determinism.** With `fonts-wqy-zenhei`, `fonts-droid-fallback`, `fonts-ipafont-gothic`, `fonts-ipafont-mincho`, `fonts-nanum` and `fonts-noto-cjk` installed, `pnpm roundtrip` passes, and Inkscape's PNG in each case is byte-identical to the run without them.
- **The worst region changes** from `Point Type` (8.69%, unchanged) to the Korean Area Type (8.73%). Its glyphs match. The difference comes from Pango, not from this ADR: Pango draws a space in the font of the character before it, so Inkscape draws the space after a Hangul word in Noto Sans KR (224 units). Kalamo, resvg and browsers draw it in Source Sans 3 (200 units), and each later word on the line shifts by the difference. The same rule costs `Bold 小动物 Kalamo` its 4.34%, from the space after 小动物. With the spaces after Hangul removed, the Point Type region scores 0.53%. Korean puts a space between words, so the fixture keeps them. #170 tracks the divergence, which could also move an Area Type line break in Inkscape. Amended by ADR-0067: export writes such a space in a tspan of its own, so Inkscape draws it in Source Sans 3; the Korean Area Type scores 0.63% and `Bold 小动物 Kalamo` 0.31% with no edit, and the worst region is `Point Type` again.

## Worker and browser

- `wrangler deploy --dry-run` measures the Worker at 33,318 KiB, 24,473 KiB gzip, against 23,829 KiB and 16,971 KiB gzip on `main@5cc7af9`. The limit is 64 MiB uncompressed.
- Peak wasm memory of one `new Resvg` and `render()` of a one-line text, in Node with resvg-wasm 2.6.2, one fresh process per case, read from the module's linear memory size: Latin only, with 6 faces, 3.9 MB; CJK only, with 8 faces, 20.9 MB; Hangul only, with 8 faces, 13.4 MB; Latin, CJK and Hangul, with 10 faces, 30.4 MB. Each takes 25 to 35 ms. ADR-0063's 23 MB and 33 MB came from a render it does not describe, so the two sets of figures are not comparable. The isolate limit was not measured in workerd. Bounded from the parts: the whole Worker script, every Data module included, is 33,318 KiB (34.1 MB), and a render copying all ten faces peaks at 30.4 MB of wasm memory, so the two together are about 65 MB against the 128 MB limit. A Latin-only render loads no Noto module and copies none.
- The browser downloads 9.5 MB more, and only for a Document that draws Hangul. The runs add 143 KB to the web bundle, 35 KB gzip: 617 KB (205 KB gzip) before, 760 KB (239 KB gzip) after. Noto Sans KR covers only the Hanja used in Korean, so its 1000-unit Han advances split into 4,339 runs per face. Noto Sans SC needed 849 runs in all. Writing each run's start as its distance from the previous run's end would cut the gzip cost to about 13 KB, but this ADR keeps ADR-0063's format.

## Considered Options

- **Noto Sans KR before Noto Sans SC.** Hanja and kanji in a Source Sans 3 text would change to Korean forms, and every existing Document with CJK would change.
- **Noto Sans CJK KR, the full OTC or the Korean region of it.** It holds every region's forms at 20+ MB per weight. The KR subset covers Korean.
- **Accepting Noto Sans KR by family name or glob in `fonts.conf`.** A system copy of the family would pass the family accept. A glob accept does not override a pattern reject.
- **Keeping Han in Noto Sans SC by `lang`.** A pattern's `lang` comes from the locale, not from the text, so it cannot select a face per character.

## Consequences

- Korean draws real Hangul in `render`, PNG and SVG export, the canvas and text Clipping Paths. Its bounds and Area Type wrapping use Noto Sans KR's metrics, its lines stack by leading alone (ADR-0080), and it does not warn `MISSING_GLYPHS`. Characters none of the three families has, such as emoji, Thai, Arabic and Devanagari, still draw the first family's `.notdef` box (ADR-0065), and the canvas's box tests stay unchanged.
- The canvas's `ctx.font` lists all three families, for example `12px "Source Sans 3", "Noto Sans SC", "Noto Sans KR"`.
- The PNG render tests (`packages/render/src/png.test.ts`) and the edge render tests (`apps/edge/test/render.test.ts`) load each lazy family in a `beforeAll`, since the test pool's import of it takes seconds (#213, #214).
- Adding a bundled family means one `FAMILIES` entry, its metrics output in `font-metrics.mjs`, and one entry in each font map, which the key tests enforce.
