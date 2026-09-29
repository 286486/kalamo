---
status: accepted
date: 2026-09-25
---

# Font Style is Illustrator's style name, bundled in six faces and matched as CSS matches

ADR-0013 bundles Source Sans 3 Regular only, so a text has one weight and an Agent that wants bold lettering fakes it with a Stroke (#19). F-TEXT-02 asks for font family and style. This ADR adds the style half. It amends the Font bullet of ADR-0013, and ADR-0017's `FONT_MISSING` now covers the style as well as the family.

## The attribute

A text Node stores `fontStyle` flat beside `fontFamily` and `fontSize`, as Illustrator's Character panel shows it beside the family. Its value is a style name: a weight name, optionally followed by ` Italic`, and `Italic` alone for Regular Italic. The default is `Regular`.

| Weight name | CSS `font-weight` |
|---|---|
| `Thin` | 100 |
| `ExtraLight` | 200 |
| `Light` | 300 |
| `Regular` | 400 |
| `Medium` | 500 |
| `Semibold` | 600 |
| `Bold` | 700 |
| `ExtraBold` | 800 |
| `Black` | 900 |

These are the CSS Fonts and OpenType weight names; Source Sans 3's faces use seven of them, all but Thin and ExtraBold. That gives 18 values in all, such as `Bold`, `Black Italic`, `Italic` and `Semibold`. Any other string is a validation error that lists them. A style name maps both ways to a CSS weight and an italic flag, so SVG export and import need no table beyond this one.

The value is a closed set rather than any string, unlike `fontFamily`. A family name has to survive a round trip untouched (F-TEXT-11), and SVG carries it as the same free string. SVG has no style name. It carries a weight number and `font-style`, so a free-form name such as "Condensed Bold" could not be exported, and one read back from SVG could only be one of these 18.

## Bundled faces

Six faces of Source Sans 3 3.052 ship under `packages/render/fonts/`, unmodified per the OFL, the Regular already there and five more: Regular, Italic, Bold, Bold Italic, Black and Black Italic. Every bundled weight has its italic, so italic never has to be synthesised. All six share `unitsPerEm` 1000, ascender 1000 and descender −326.

A style the bundle lacks renders in the nearest bundled face by CSS Fonts' matching rules. Italic is chosen first. Then a weight at or below 500 looks lighter first and then heavier, and a weight above 500 looks heavier first. So `Thin`, `ExtraLight`, `Light` and `Medium` render in Regular, `Semibold` in Bold, and `ExtraBold` in Black, with the same italic.

resvg's font database implements exactly these rules. With the six faces loaded, `font-weight` 300 and 500 draw as 400, 600 as 700, 800 as 900, and `oblique` as `italic` (measured with resvg-wasm 2.6.2). Browsers implement the same rules over `FontFace`s registered with `weight` and `style` descriptors. `core` implements them once, so that bounds are measured in the face the renderers draw.

The `FONT_MISSING` receipt warning now fires when a text's family or style is not bundled. It names the face that is drawn, for example "Source Sans 3 Semibold is not bundled, so it renders in Source Sans 3 Bold; the name is kept." A family the bundle lacks still renders in Source Sans 3, in the matched style.

## Measuring and drawing

- **Bounds.** The generated advance table becomes one table per bundled face. The script reads all six TTFs. `layoutText` and `textBox` take the advances of the face that `fontStyle` matches. Point Type and Area Type wrap and measure by that face's advances. The vertical metrics are shared.
- **SVG** (`render`, export). `font-weight` and `font-style` are written as presentation attributes beside `font-family` and `font-size`. Only a non-default value is written, so a Regular text's SVG is unchanged. The stored style is written, not the matched face: `Semibold` exports as 600, and resvg, Inkscape and a browser each match it to Bold.
- **Canvas.** `ctx.font` names the matched face's weight and italic. The browser loads all six TTFs as `FontFace`s with their descriptors and redraws once they have all loaded.

## SVG import

`font-weight` is read from the text's computed style. `normal` is 400 and `bold` is 700. A number rounds to the nearest hundred in 100–900. `bolder` and `lighter` resolve against 400 as CSS Fonts' table does, to 700 and 100. `font-style` `italic` or `oblique` adds ` Italic`. The weight and italic map back to the style name, so a Zibel export reopens as the same `fontStyle`. Inkscape's `-inkscape-font-specification` is ignored: Inkscape keeps it in step with `font-weight` and `font-style`, and writes both.

## Considered Options

- **A free string, like `fontFamily`.** It follows Illustrator more closely, but SVG cannot carry a style name, so an arbitrary name has no export mapping.
- **`fontWeight` number and `italic` boolean, as CSS stores them.** Equivalent to the chosen model, but Illustrator, Figma (`fontName.style`) and the Character panel all name the style, and the canonical terms follow Illustrator.
- **Only the three faces #19 names (Bold, Black, Italic).** That leaves Bold Italic, the most common combined style, to be synthesised, which resvg does not do and browsers do differently.
- **All 14 static faces, or the variable font.** The 13 other static faces would add about 4.8 MB to the Worker. The two variable fonts hold every weight, but whether resvg-wasm 2.6 draws a variable font's instance by `font-weight` is unverified, while static faces are measured to match. Six faces cover Illustrator's common styles.
- **Lazy-loading faces in the browser.** This saves about 1.8 MB of downloads when a Document uses only Regular, but canvas drawing does not reliably trigger a `FontFace` load, so the canvas would need a load-then-redraw per face. Eager loading is one `Promise.all`.

## Consequences

- The five TTFs add 1.8 MB, and five more advance tables in `core` add about 170 KB. `wrangler deploy --dry-run` measures the Worker at 6523 KiB, 2365 KiB gzip, against 4.2 MB and 1.4 MB gzip before (#19). Workers limit only the uncompressed size, to 64 MiB on both plans (docs/research/04-cloudflare-limits.md). The tables are also in the browser's JavaScript bundle, which grows from 365 KB (117 KB gzip) to 435 KB (143 KB gzip), and the browser downloads the six TTFs, 2.2 MB uncompressed, beside it.
- A text Node stored before this ADR has no `fontStyle`: the Durable Object loads stored Nodes without the schema, and the browser takes them as sent. Every reader goes through `fontFace` or `bundledStyle` in `core`, which read a missing style as `Regular`, and the schema default fills the field on the Node's next write. No hosted Document predates M1.
- Italic bounds are advance sums, as upright bounds are. Italic overhang past the last advance is outside the geometric bounds until HarfBuzz and glyph bounds (F-TEXT-09).
- The style of a range of characters arrives with runs (ADR-0013). `fontStyle` stays the Node-level default that a run overrides.
- Amended by ADR-0063: Noto Sans SC Regular and Bold are bundled for the characters Source Sans 3 lacks, matched by the same CSS rules, its CJK upright for an italic.
