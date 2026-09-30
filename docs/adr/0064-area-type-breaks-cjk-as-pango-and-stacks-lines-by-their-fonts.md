---
status: accepted
date: 2026-09-29
---

# Area Type breaks CJK text where Pango does, and stacks each line by the fonts it draws in

ADR-0022 wraps Area Type greedily at spaces. A Chinese, Japanese or Korean paragraph has no spaces, so it was one word wider than the frame: it and everything after it overflowed, and `node_create` warned `TEXT_OVERFLOW` with nothing drawn (#160). Inkscape 1.2.2 breaks the same paragraph between characters with Pango's UAX #14 line breaking. This ADR adds those break opportunities. It also fixes where Inkscape puts a line that holds CJK, which the round-trip fixture exposed once CJK wrapped. It amends ADR-0022's Wrapping, First baseline and Overflow bullets, and ADR-0063's decisions 5 and 6.

## Break opportunities

`core/line-break.ts` splits a paragraph into unbreakable units. The wrap loop of ADR-0022 then takes units where it took words, so `layoutText`'s signature, `glyphs`, the canvas, SVG export and `TEXT_OVERFLOW` do not change. A unit keeps the spaces after it, so lines and `overflow` still join back into `content`, and line `start` offsets are still code points.

- **Spaces break as before.** A break follows every run of white space, trailing spaces hang past the frame, and a hard return ends a paragraph. Two non-space characters never break when neither is CJK, so Latin text wraps exactly as ADR-0022 wraps it.
- **Between two non-space characters where one is CJK, a line breaks unless a class forbids it.** CJK means Han (with the CJK radicals, strokes and compatibility ideographs), kana, Hangul syllables and jamo, Bopomofo, Yi, the CJK symbols and punctuation block, and the full-width and half-width forms. This covers UAX #14's ID, H2, H3, JL, JV, JT, CJ, and the NS, CL and OP characters of CJK width.
- **No break before** closing, non-starter, exclamation, infix, hyphen, quotation, inseparable, glue, word-joiner, zero-width and combining characters (CL, CP, EX, IS, SY, NS, CJ, IN, BA, HY, QU, GL, WJ, ZW, CM), and Hangul's vowel and trailing jamo (JV, JT). This includes `。，、．）」』】〉》！？：；`, `ー`, `々`, `・`, small kana, and ASCII `!),.:;?]}"'-/|`.
- **No break after** opening, quotation, before-break, glue and word-joiner characters (OP, QU, BB, GL, WJ), and Hangul's leading jamo (JL), so conjoining jamo stay one syllable. This includes `（「『【〈《〔`, `“‘`, and ASCII `([{"'`.
- **Prefix and postfix signs** (PR, PO) stay with an ideograph: `$字` and `字%` do not break, while `$「` and `」%` do.

So `使用SVG格式` breaks as `使|用|SVG|格|式`, `「字」` is one unit, and a single ideograph, or a cluster such as `「字」`, overflows only when it alone is wider than the frame.

**How it was checked.** Pango 1.50.12, the version Inkscape 1.2.2 links on this machine, was called through `pango_get_log_attrs`. Every assigned code point in the Han, kana, Hangul, Yi, CJK punctuation and full-width blocks, and in ASCII, Latin-1, General Punctuation, currency and letterlike symbols, was placed after and before `字`, and the CJK blocks also after and before `a`. Every result equals the table's, except for combining marks tested at the start of a string, characters that Unicode added after GLib's tables, and conjoining jamo beside a non-jamo, which Kalamo keeps attached so that a decomposed syllable stays whole, as Pango does. On 20,000 random strings of CJK, kana, Hangul, CJK and ASCII punctuation, Latin letters and digits, the only CJK-adjacent differences are 22 inside number sequences (UAX #14 LB25).

**Left out:**

- Breaks that need no CJK neighbour: emoji (ID), the B2 em dash, ZWSP as a break opportunity, and Latin punctuation such as `a!|b`. These would change Latin wrapping, which stays at spaces.
- Rules that look across spaces: LB14 (`OP SP* ×`), LB13 after a space (`SP × CL`), LB15 and LB16, and LB25's number sequences.
- Thai, Lao, Khmer and other dictionary-based breaking.

`Intl.Segmenter` has no line granularity, so the classes live in `core` as three regular-expression character classes and two small sign sets. That keeps the table compact, because `core` ships in the Worker, the browser and `io`.

## A line holding CJK is as tall as Inkscape stacks it

Superseded by ADR-0080: Area Type stacks every line by leading alone, as Illustrator does, and export gives each fallback run a `line-height` that makes Inkscape 1.2.2 stack it the same way. The measurements below explain why Inkscape needs that.

With the fixture wrapping, Inkscape drew each CJK line 1.76 pt lower than Kalamo at 14 pt, and hid the last line as overflow. Inkscape sizes lines as CSS inline boxes do. Each family on a line has an em box, its OS/2 typographic ascender and descender scaled to sum to one em, with half the leading above and below. The line is as tall as the union of the text's first family's box (the strut) and the boxes of the families its characters draw in. Source Sans 3's box is 1000 / 1326 above the baseline and 326 / 1326 below. Noto Sans SC's is 880 above and 120 below. So with Auto leading, a line that holds a Noto character rises `fontSize · (0.88 − 0.754)` above a Latin line, and its descent stays Source Sans 3's.

`layoutText` stacks Area Type lines this way. The first baseline sits one line-box ascent below the frame's top, and each later baseline sits the previous line's descent plus its own ascent below the one before. A Latin-only line is exactly one leading tall, so Latin text lays out as ADR-0022 describes. Overflow uses the thresholds measured in Inkscape 1.2.2 at 12, 14 and 20 pt, with Auto, 2 and fixed leading:

- the first line shows while 90 % of its height lies in the frame;
- a later line shows while 90 % of the leading lies in the frame, measured from the line's top;
- a later line taller than the strut shows only while its whole leading lies in the frame.

`font-metrics.mjs` now reads OS/2's typographic ascender and descender, which equal hhea's in Source Sans 3, and also writes Noto Sans SC's. Point Type does not change. Inkscape keeps the `y` of each `sodipodi:role="line"` tspan as written, so its lines stay one leading apart.

## Illustrator

Illustrator also breaks between ideographs. Its Kinsoku Shock sets (Hard, Soft) forbid about the same line starts and ends as UAX #14's CL, NS and OP. It can also hang punctuation past the frame (Burasagari) and push or pull characters to satisfy kinsoku. Illustrator keeps leading as the fixed distance between baselines, whatever fonts a line uses. Kalamo follows Pango and Inkscape instead, as ADR-0022 chose Inkscape's overflow and first baseline: the exported file is edited in Inkscape, and it must show the same lines there. Hanging punctuation, burasage and Illustrator's kinsoku sets are out of scope (#160).

## Considered Options

- **The full UAX #14 pair table.** Its 40-odd classes and pair rules would also change Latin wrapping around punctuation and emoji, and would take a larger table in every bundle. The three-flag reduction matches Pango on every CJK pair checked.
- **`Intl.Segmenter`.** It has no line granularity.
- **Keeping the line pitch at the leading, as Illustrator does.** With it, Inkscape hid lines that Kalamo draws. The fixture's fifth line overflowed there.
- **Noto's hhea metrics (1160 / −288).** Inkscape does not use them. The measured baselines match the typographic ones.

## Consequences

- MCP's `node_create` description and `drawing-conventions.md` say Area Type wraps at spaces and between CJK characters.
- `pnpm roundtrip` compares each Area Type's shown lines in the exported SVG with the lines Inkscape writes on save. The inkscape fixture gains a CJK Area Type Artboard: one paragraph of Chinese and Japanese with `「」，。`, `ー` and small kana, on five lines, where `「` must move to the second line with `矢`. Its region differs by 1.1 % against the 15 % text budget.
- Korean wraps between syllables. It still draws `.notdef` boxes until #164, and until then each Hangul syllable is measured at the `.notdef` advance. Amended by ADR-0066: Hangul draws in Noto Sans KR and is measured by its advances, and a line holding it stacks by Noto Sans KR's em box, which equals Noto Sans SC's (880 / −120).
- Amended by ADR-0068: the boxes are taken at the line's largest size and with the line's own leading, 120 % of that size with Auto, and each later baseline sits that leading, plus what CJK adds, below the one before. A text of one size stacks exactly as above.
- A line mixing CJK with Source Sans 3 characters is taller than the leading. So a fixed `leading` does not give a fixed baseline-to-baseline distance for CJK in Area Type, as it does in Illustrator. Amended by ADR-0080: it does now, and only ADR-0022's 90 % threshold remains.
