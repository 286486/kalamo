# Line stacking of text that falls back to another family (research notes, 2026-09-30)

For #199: how Illustrator and Inkscape 1.2.2 stack the lines of Point Type and rectangular Area Type when a line holds characters drawn in a fallback family, such as CJK drawn in Noto Sans SC beside Source Sans 3. Decision: ADR-0080.

Legend as in `06-illustrator-drawing-tools.md`: **[A]** the Adobe doc states it; **[M]** measured here.

## Illustrator

Access note: helpx.adobe.com returns 403 to WebFetch and to `curl` from this host on 2026-09-30, whatever the User-Agent. The Asian type passage is quoted from the Wayback Machine's 2025 capture of the page (`https://web.archive.org/web/2025id_/<url>`). For the other two pages the capture holds only the navigation, so their sentences are quoted from the search index's extract of the live page.

- **[A]** "Line and character spacing in Illustrator", https://helpx.adobe.com/illustrator/using/line-character-spacing.html: "Leading is measured from the baseline of one line of text to the baseline of the line above it." "The default auto-leading option sets the leading at 120% of the typeface size." ADR-0068 records the rest of the rule as Kalamo follows it: a line takes the largest leading among its characters, so Auto follows the line's largest size.
- **[A]** "Format East Asian characters in Illustrator", https://helpx.adobe.com/illustrator/using/formatting-asian-characters.html: "Top-to-Top Leading: Measures the spacing between lines of type from the top of one line to the top of the next line. When you use top‑to‑top leading, the first line of type in a paragraph is aligned flush with the top of the bounding box. Bottom-to-Bottom Leading: For horizontal type, measures the space between lines of type from the type baseline. When you use bottom-to-bottom leading, space appears between the first line of type and the bounding box." And: "The leading option you choose does not affect the amount of leading between lines, only how the leading is measured."
- **[A]** "Edit text with missing fonts in Illustrator", https://helpx.adobe.com/illustrator/desktop/design-with-text/fonts-and-scripts/edit-text-without-replacing-missing-fonts.html: "Missing glyph protection is enabled by default in Illustrator." "Illustrator will substitute the missing fonts with the default font and highlight the text."

**The rule they give.** A line's baseline is its leading below the previous line's baseline. The leading is the largest leading value on the line, 120 % of the type size when Auto. Point Type and Area Type are not told apart. Asian type can change where the leading is measured from, not how much of it there is. Kalamo has only baseline to baseline, Illustrator's default. A substituted glyph is drawn in another font, and no passage says the substitute font changes leading.

**What they leave open.** No passage says whether a substitute font's taller ascent or deeper descent pushes a line down, or how Area Type's First Baseline (Ascent) treats a first line whose substitute font rises higher. Following the documented rule, leading alone sets every later baseline, and the first baseline stays ADR-0022's, from the text's own family. Checking this needs a live Illustrator, which this host does not have.

## Inkscape 1.2.2

`08-line-stacking/probe.mjs` writes each case as an SVG under `08-line-stacking/out/` and runs `inkscape --query-all` on it with the bundled fonts, through a `fonts.conf` built as `pnpm roundtrip` builds its own. Every line starts with an "H" in its own tspan. The bottom of the "H" is the line's baseline. The text is 20 px Source Sans 3 at x 20, y 40. Its CJK is `字字`, which falls back to Noto Sans SC. Area Type flows in a 300 × 300 `shape-inside` rect, with lines ended by hard returns. Point Type uses `sodipodi:role="line"` tspans, 24 apart as written.

Reproduce with `node docs/research/08-line-stacking/probe.mjs`, which prints `results.tsv`. `node docs/research/08-line-stacking/probe.mjs thresholds` prints only the overflow thresholds. It takes a few minutes.

**Forms tried** (`FORMS` in the script):

- `current`: what Kalamo wrote before #199. `line-height` is unitless `1.2` for Auto, else `Npx`, on the `<text>`. The CJK has no style of its own.
- `absolute`: `line-height` in px on the `<text>`, for Auto too.
- `noto-first`: `font-family="'Noto Sans SC', 'Source Sans 3'"`, so Noto Sans SC sets the strut. Its Latin then draws in Noto Sans SC too, which changes the glyphs.
- `run-line-height`: the `current` text, with each fallback run's tspan styled `line-height: 1.2 − 2·(0.88 − 1000/1326)`, which is 0.948, for Auto, and `L − 2·(0.88 − 1000/1326)·size` px for a set leading `L`. Both are rounded down to a thousandth. The run's CSS inline box then lies inside the box that Source Sans 3 has at its size and leading.
- `run-line-height-rounded`: the same, rounded to the nearest thousandth.
- Pinning each line of a `shape-inside` text is not tried again. ADR-0068 measured that Inkscape ignores a line tspan's written `y` when it draws, and flowed text has no positioned lines to pin.

**Cases.** `cjk-second`: Latin on the first line, CJK on the second. `cjk-first`: CJK on the first line. `cjk-larger`: `cjk-second` with the CJK at 30 px. `latin`: no CJK. Each case is set once with Auto leading and once with leading 30.

**Baselines [M].** "first" is the first baseline below the frame's top (Area Type) or below `y` (Point Type). "steps" are the distances from each baseline to the next. Kalamo gives, by Illustrator's rule: first 17.08 at Auto and 20.08 at 30, steps 24 24 24 and 30 30 30, and for `cjk-larger` 36 24 24 at Auto and 30 30 30 at 30.

| Kind | Leading | Case | current | absolute | noto-first | run-line-height |
|---|---|---|---|---|---|---|
| Point | Auto | cjk-second | 26.52 24 24 | 26.52 24 24 | 24 24 24 | 24 24 24 |
| Point | Auto | cjk-larger | 36.32 24 24 | 30.32 24 24 | 33.8 26.2 24 | 32.54 24 24 |
| Point | 30 | cjk-second | 32.52 30 30 | 32.52 30 30 | 30 30 30 | 30 30 30 |
| Point | 30 | cjk-larger | 36.32 30 30 | 36.32 30 30 | 33.8 30 30 | 32.54 30 30 |
| Area | Auto | cjk-second | 17.08; 26.52 24 24 | 17.08; 26.52 24 24 | 19.6; 24 24 24 | 17.08; 24 24 24 |
| Area | Auto | cjk-first | 19.6; 24 24 24 | 19.6; 24 24 24 | 19.6; 24 24 24 | 17.08; 24 24 24 |
| Area | Auto | cjk-larger | 17.08; 36.32 24 24 | 17.08; 30.32 24 24 | 19.6; 33.8 26.2 24 | 17.08; 32.54 24 24 |
| Area | 30 | cjk-second | 20.08; 32.52 30 30 | 20.08; 32.52 30 30 | 22.6; 30 30 30 | 20.08; 30 30 30 |
| Area | 30 | cjk-first | 22.6; 30 30 30 | 22.6; 30 30 30 | 22.6; 30 30 30 | 20.08; 30 30 30 |
| Area | 30 | cjk-larger | 20.08; 36.32 30 30 | 20.08; 36.32 30 30 | 22.6; 33.8 30 30 | 20.08; 32.54 30 30 |

Point Type's first baseline is `y` in every form. `latin` gives Kalamo's numbers in every form except `noto-first`, whose Noto strut moves an Area Type's first baseline to 19.6 or 22.6. `run-line-height-rounded` gives the same baselines as `run-line-height`.

Findings:

- In `current` Inkscape stacks a CJK line of the text's size 2.52 lower than its leading, 20 × (0.88 − 0.754) (ADR-0064), in **Point Type too**. So before #199 Kalamo's Point Type, with CJK on a later line, already drew its later lines lower in Inkscape.
- `absolute` changes only Auto `cjk-larger`. The larger run's box then takes the text's 24 px, not 1.2 × 30.
- `noto-first` stacks a CJK line of the text's size by leading, but it moves the first baseline of every Area Type, Latin-only included, and draws Latin in Noto Sans SC.
- `run-line-height` stacks every line of the text's size by leading alone, in both kinds, under Auto and a set leading, with CJK on the first line or a later one. The first baseline is ADR-0022's. The lines after a larger CJK run are also where Illustrator puts them. The larger line itself lands where Inkscape puts a Latin run of that size (ADR-0068's model difference): 32.54 below the line before, where Illustrator's rule gives 36 at Auto and 30 at 30.

**Overflow thresholds [M].** The least frame height, bisected to 0.01, at which Inkscape shows lines 1, 2 and 3 of an Area Type:

| Leading | Case | current | run-line-height | run-line-height-rounded |
|---|---|---|---|---|
| Auto | cjk-first | 23.87 48.12 72.13 | 21.61 45.6 69.61 | 21.61 45.6 69.61 |
| Auto | cjk-second | 21.61 48 72.13 | 21.61 45.6 69.61 | 21.61 45.6 69.61 |
| Auto | latin | 21.61 45.6 69.61 | 21.61 45.6 69.61 | 21.61 45.6 69.61 |
| 30 | cjk-first | 29.27 59.52 89.52 | 27.01 57 87 | 27.01 57.01 87 |
| 30 | cjk-second | 27.01 60 89.52 | 27.01 57 87 | 27.01 60 87 |
| 30 | latin | 27.01 57 87 | 27.01 57 87 | 27.01 57 87 |

With `run-line-height`, every line shows at the Latin threshold: 90 % of its leading, measured from its top (ADR-0022). With `current`, a later CJK line needs its whole leading in the frame (ADR-0064's third threshold). `run-line-height-rounded` shows why the value is rounded down. At leading 30, 30 − 5.034 rounds up to 24.966 px, which puts the run's box 0.0001 px above the strut, and the CJK line again needs its whole leading. A scratch probe that varied the run's line-height gave the same step. At leading 30, the second line needs 57 up to 22.45 px and 60 from 25 px. At Auto it needs 45.6 up to 0.948 and 48 from 1.0. Only the box's top edge crossing the strut's matters.

ADR-0064's line breaks do not depend on stacking. `pnpm roundtrip` compares each Area Type's shown lines with the lines Inkscape saves, and they held for every fixture text (ADR-0080).

## Round trip [M]

With `run-line-height` written by export, `pnpm roundtrip` passes. The new "CJK Line Stacking" Artboard holds a three-line Point Type whose second and third lines mix Latin and CJK, and an Area Type at leading 18 whose third shown line, CJK, sits 0.8 pt inside its 90 % threshold. They differ by 4.24 % and 3.83 % against the 15 % text budget. The CJK and Korean Area Types differ by 1.16 % and 0.5 %. With the same layout but without the run `line-height`, the round trip fails. Inkscape hides the Area Type's third line, and the regions differ by 20.9 % to 34.1 %.
