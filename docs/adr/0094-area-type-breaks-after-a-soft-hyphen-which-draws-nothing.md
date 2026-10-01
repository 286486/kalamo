---
status: accepted
date: 2026-10-02
---

# Area Type breaks after a soft hyphen, which draws nothing and takes no width

ADR-0085 left U+00AD SOFT HYPHEN out of its break-after set, because drawing and measuring it is hyphenation. Kalamo measured it at a hyphen's width, and a line could not break at it. Text pasted from the web, or written by an Agent, often holds soft hyphens, as in `hy{SHY}phen{SHY}ation` (`{SHY}` is U+00AD). In Kalamo such a word could not wrap at them, and each one widened it by a hyphen. Inkscape 1.2.2 wraps there and draws nothing (#227). This ADR makes U+00AD a break opportunity with no width and no ink. It amends ADR-0085's decision 1 and "Left out". It covers the soft hyphen only, not automatic hyphenation.

## Evidence

`|` stands for a break opportunity.

**Pango 1.50.12 [M]**, `pango_get_log_attrs` through `docs/research/10-latin-breaks/pango.py`, measured on 2026-10-01 and 2026-10-02. U+00AD is BA in GLib 2.74.6.

- Breaks: `hy{SHY}|phen{SHY}|ation`, `a{SHY}{SHY}|b`, `a{SHY} |b`, `a{SHY}-|b`, `a-{SHY}|b`, `1{SHY}|2`, `a{SHY}|␣b` (␣ is U+00A0), `a{SHY}|%`, `a{SHY}◌́|b`, `a{SHY}|—|b`, `a{SHY}!|b`, `a{SHY}{ZW}|b`, `a{SHY}|(b`, `a{SHY}|$5`, `{SHY}|ab`, `a |{SHY}|b`.
- No break: `a{SHY})b`, `א{SHY}b` (LB21a), `a{SHY}⁠b` (WJ).

These are ADR-0085's rules for a BA character, so U+00AD needs no rule of its own.

**Inkscape 1.2.2 [M]**, with Source Sans 3 from `packages/render/fonts`:

- A `<rect>` frame 45 wide, 12 px, as `docs/research/10-latin-breaks/inkscape.mjs` writes it: `xxxx x{SHY}yyyyyy` saves as `xxxx x{SHY}` · `yyyyyy`. Inkscape's PNG export of the saved file draws `xxxx x` and `yyyyyy`, with no hyphen at the break. On `main` (f9cf742), Kalamo gave `xxxx ` · `x{SHY}yyyyyy`.
- Point Type `ab a{SHY}b a-b` at 30 px draws `ab ab a-b`: the soft hyphen draws nothing and takes no width.
- `--query-width` of Point Type at 30 px, `font-kerning:none`: `ab` and `a{SHY}b` are both 28.8 wide, and both 38.8 with `letter-spacing="10"`. `a-b` is 38.13 and 58.13. So Inkscape adds no letter spacing after a soft hyphen. The letter spacing after the character before it still counts where a soft hyphen ends a line: in a frame 140 wide at 60 px with `letter-spacing="12"`, `xx x{SHY}yyy` saves as `xx ` · `x{SHY}` · `yyy`, and `xx x yyy` as `xx x ` · `yyy`.

**resvg [M]**, through `svgToPixels`: without letter spacing, `a{SHY}b` draws the same pixels as `ab`, in a line, at an Area Type break and as a text Clipping Path. With letter spacing, resvg adds it after the soft hyphen too, and the `b` lands one tracking further right than Inkscape draws it.

**Chrome [M]**, the canvas through Playwright: `fillText` draws nothing for U+00AD, both in a whole line and alone.

**Kalamo on `main` [M]**: `glyphs` of `a{SHY}b` at 100 px gave U+00AD a width of 31.1, the same as `-`.

**Illustrator [A]: unverified.** Adobe's "Insert white space and break characters in Illustrator" describes the discretionary hyphen, which shows a hyphen only where the word breaks. helpx.adobe.com returns 403 to this host, as ADR-0085 records, and no live Illustrator is available.

## Decision

1. **U+00AD breaks after**, as BA in ADR-0085's break-after set. ADR-0085's suppressions apply unchanged: no break before a character that may not start a line (`a{SHY})b`), after a Hebrew letter (`א{SHY}b`) or before WJ. A soft hyphen still never starts a line after a letter, since it is in ADR-0064's no-break-before set.
2. **A soft hyphen has no width and no tracking.** `metrics` in `text.ts`, which every consumer reads widths from, gives U+00AD an advance of 0 and a tracking of 0. So the tracking of the character before a soft hyphen that ends a line counts toward the fit, as in Inkscape. `glyphs`, `layoutText`'s fit, bounds, `lineBounds`, Auto Size and alignment all measure it as nothing, and the character before it keeps its own tracking. The renderers keep no rule of their own for its width.
3. **Nothing is drawn at a break.** A line that breaks at a soft hyphen ends in U+00AD, as Inkscape saves it, and no hyphen is drawn there. This follows Inkscape, not Illustrator's discretionary hyphen. The SVG file is the format Kalamo shares with Inkscape (ADR-0017). Kalamo writes Area Type as one positioned tspan per line, and no SVG renderer Kalamo checks draws a hyphen for a line-final U+00AD: Inkscape, resvg and Chrome all draw nothing. A hyphen drawn in Kalamo alone would make the canvas and `render` differ from Kalamo's own export in every viewer. Writing a `-` into the export would change `content` on the round trip, and #227 forbids that. Illustrator's discretionary hyphen is also unverified, and it belongs to Illustrator's hyphenation, which is out of scope.
4. **The character stays.** `content`, SVG export and Convert to Point Type keep each U+00AD. ADR-0079's Convert to Point Type inserts its `\n` after a soft hyphen that ends a line, as after any break with no space.
5. **resvg starts a text chunk after a soft hyphen.** For resvg only (`chunked`, ADR-0063), the SVG writer gives the character after U+00AD its own `x`, so resvg's letter spacing after the soft hyphen moves nothing. The SVG for Inkscape and other viewers is unchanged. This is not a second width rule: the width is still `metrics`' alone, and the chunk only makes resvg draw each glyph where that width puts it.
6. **The canvas needs no change.** `fillText` draws nothing for U+00AD, and the per-character path places each glyph at the zero-width layout's origin. A text Clipping Path is hit-tested by drawing it on a scratch canvas (ADR-0052), so it follows the same drawing. Kalamo's browser editor has no Type tool and no text caret yet (F-TEXT-01), so no caret or text selection steps over a soft hyphen.

## How it was checked

- **Pango's strings.** `text.test.ts` asserts Pango's units for every string above. ADR-0064's, ADR-0085's, ADR-0087's and ADR-0093's assertions are unchanged and pass.
- **Inkscape's frame.** `layoutText` gives `xxxx x{SHY}` · `yyyyyy` for the 45-wide frame, and `inkscape.mjs` adds it to `inkscape.tsv`.
- **Width and drawing.** `text.test.ts` asserts that a soft hyphen has width 0 in `glyphs`, adds no tracking, and leaves `textBox` and `linesBox` as without it, in a line and at a break. `png.test.ts` asserts that `render` draws `a{SHY}b`, tracked, as `ab`, in a line, as a text Clipping Path, and at an Area Type break as the same text with a space. `write.test.ts` asserts that export keeps U+00AD at the end of its line's tspan and writes no hyphen. `edit.test.ts` asserts that Convert to Point Type keeps it. `apps/web/e2e/soft-hyphen.spec.ts` asserts that the canvas draws each case, tracked and not, and a text Clipping Path, with the same pixels as without the soft hyphen, and that a click on a glyph past a soft hyphen selects the tracked text, and inside the text Clipping Path's glyph its Clip Group. `text.test.ts` and `png.test.ts` assert the tracked break in the 140-wide frame as Inkscape saves it.
- **Random strings against Pango.** `docs/research/10-latin-breaks/check.ts`, with U+00AD added to the `latin` pool and to its "after / - or BA" rule. `check.ts latin f9cf742` prints:

  ```
  20000 strings, 2634 with a break that differs from Pango's
  1311 IS, CL, CP, PR or PO before NU, OP, PR or PO
  1183 a space before it: LB13 to LB16, across spaces
  372 a CJK neighbour: ADR-0064's pairs
  9 a space before a no-break space: LB13 to LB16, across spaces
  against f9cf742: 1049 strings change at 1077 positions, 4 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango
  ```

  No difference falls after U+00AD. The 4 removed breaks are each a Hebrew letter, a soft hyphen and an em dash, such as `א{SHY}—`: LB21a now keeps the em dash after the soft hyphen, as Pango does. `check.ts cjk f9cf742` changes nothing.
- **Layout from `main`.** #203's check: `docs/research/10-latin-breaks/regress.ts f9cf742`, with U+00AD, U+00AD U+00AD, U+00AD and a space, `-` U+00AD, and U+00AD `)` added to its joins, prints `60000 texts, 45070 hold U+00AD; 44923 changed, 0 of them without one`.

## What changes

Every text that holds U+00AD changes its widths, and an Area Type can change its lines. The fixture's "Latin Breaks" Artboard widens from 590 to 740 to hold a fifth Area Type, `Soft hy{SHY}phens let in{SHY}ter{SHY}na{SHY}tion{SHY}al{SHY}ize wrap with no hy{SHY}phen.`, 12 pt in a rectangle 120 wide. It wraps as `Soft hy{SHY}phens let in{SHY}ter{SHY}na{SHY}` · `tion{SHY}al{SHY}ize wrap with no ` · `hy{SHY}phen.`. The render golden and the `fixtures/documents/inkscape.svg` export snapshot change only by that text and the Artboard's width. `pnpm roundtrip` passes, Inkscape saves the same lines, and the text differs by 6.75 % of its 15 % budget. Every other text region prints `main`'s figures.

## Left out

- Automatic hyphenation, hyphenation dictionaries and Illustrator's hyphenation settings.
- A hyphen drawn at a soft-hyphen break, Illustrator's discretionary hyphen, as decision 3 says.
- Other default-ignorable characters, such as U+034F, U+180E and the variation selectors, which keep their font advances. U+200B already measures 0 in Source Sans 3.
- ADR-0085's and ADR-0093's other "Left out" items.

## Considered Options

- **Draw a hyphen at the break, as Illustrator documents.** The layout would fit the line with the hyphen's width, and `glyphs` and `render` would draw one. The export could not carry it without a `-` in the text, so Inkscape, resvg and browsers would draw the file without it. Every such break would differ between Kalamo and its own export, in Inkscape and in every other viewer.
- **Zero width in each renderer.** The canvas, the SVG writer and the bounds would each skip U+00AD. Measuring it once in `metrics` gives every consumer the same widths with one rule.
