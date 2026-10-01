---
status: accepted
date: 2026-09-30
---

# Area Type breaks a unit wider than its span between characters

Area Type hid a unit, such as a word, URL or CJK cluster, that fit no span down to the frame's bottom, with everything after it. It warned `TEXT_OVERFLOW` (ADR-0022, ADR-0083 rule 1). Inkscape 1.2.2 opens the exported file and breaks that unit between characters, so the same file read differently in the two editors (#221). This ADR decides when and where a unit breaks, in the one Area Type filler that ADR-0083 left, for rectangular and shaped frames alike. The measurements are in `docs/research/09-shaped-bands.md`, section "A unit wider than its span (#221)". This ADR amends ADR-0022's Overflow bullet and its Considered Options, ADR-0083's rule 1, ADR-0078's "Too narrow" bullet and its #200 amendment's "Fit", ADR-0064's cluster sentence, and ADR-0079's Convert to Point Type bullet.

## Evidence

**Illustrator [A]: none.** No Adobe page found says what Area Type does with a unit wider than its frame. Searched on 2026-09-30: "Add text and work with type objects", "Set hyphenation and line breaks", "Resize text areas", the Area Type tool page and the Illustrator scripting guide's `TextFrameItem`. helpx.adobe.com returns 403 to this host, as `08-line-stacking.md` records, so the pages were read through the search index's extracts. Only community threads mention it, and a community thread is not Adobe's documentation. ADR-0022's "Illustrator breaks the word" cited no source, and it is unverified. This host has no live Illustrator to check it. So Inkscape settles the rule, as ADR-0078 and ADR-0083 let it settle what Adobe leaves open.

**Inkscape 1.2.2 [M], and its source.** `_buildChunksInScanRun` in `src/libnrtype/Layout-TNG-Compute.cpp` at tag `INKSCAPE_1_2_2` has a "non-SVG spec bit" (bug #1191102). Suppose nothing up to a break opportunity fits a span, starting from where the span starts, and the span is at least four times the line box's height (`scan_run.width() >= 4.0 * line_height->emSize()`). Then the span ends at the last character boundary that fits, Pango's `is_char_break`. The probe confirms each part of it: `probe.mjs`'s `break` rows, saved through Inkscape, whose line tspans give each piece.

## Decision

1. **When.** A unit that starts a span and does not fit it breaks there if the span is at least four line boxes wide. The line box is the one Inkscape measures: the line's box and the text's strut joined, the larger ascent above the baseline and the larger descent below it. With one size that is four leadings: 96 at 20 pt Auto, 120 at leading 30. A narrower span is skipped, as before (ADR-0078). A rectangle whose width is under that therefore still overflows the unit and all that follows (ADR-0022). The rule is a span's, not the frame's. A 15-H word that the 300-wide body below fits still breaks in a 110-wide arm at Auto. At leading 30 it is carried down past that arm. No candidate from #221's question 2 matches that: "fits no later band", "wider than the widest span" and "first in the band" all fail.
2. **Where.** The span takes the widest prefix of whole grapheme clusters, by `Intl.Segmenter`, that is no wider than the span. The prefix is measured as Kalamo measures a line: its advances plus the tracking between its characters, not after the last (ADR-0029). The rest starts the band's next span, or the next band, and the same rule applies to it there. The units after the last piece fill that piece's span as usual, so `H HHH HHH` shares one line. Amended by ADR-0087: the prefix's trailing white space does not count, as a line's does not (ADR-0022), so a no-break space that ends a piece hangs past the span, as Inkscape 1.2.2 hangs it.
3. **A span no cluster fits** is skipped, as a span too narrow for a unit is. At leading 2 a 10-wide span is more than four line boxes wide, but no 13.04-wide H fits it. Inkscape draws nothing there, and neither does Kalamo.
4. **Sizing.** A line is sized from its first character up. So a piece's line is not sized by the rest of its unit.
   - A rectangle's line is sized by the characters it holds (ADR-0083 rule 2, Illustrator's leading, ADR-0068).
   - A shaped band is sized by the characters it tries. For a broken unit, that is up to and including the cluster that did not fit. This is where Inkscape stops measuring.
   - The width for the rule in 1 is measured with the box as sized, and a band that grows is filled again. Suppose a larger Character Range after the break makes the next line too tall for four line boxes to fit its span. That line then skips, and in a rectangle it overflows. Inkscape does the same: at 20 pt Auto, a 40-H word whose last 20 H's are 40 pt shows its first 13 H's, and a rectangle 180 wide hides the rest. At leading 30 the 40 pt box is 35.09 tall, and the word breaks 13, 10, 6, 6, 5.
5. **Every unit.** A Latin word, a word in a fallback family and an ADR-0064 CJK unit break the same way. `字` and eleven `」`, 240 wide in a 180-wide rectangle, break after nine characters, as Inkscape breaks them.
6. **Conversion and justify.**
   - Convert to Point Type inserts a `\n` after each piece, as after a CJK break (ADR-0079). Convert to Area Type makes a frame as wide as the widest line, and in that frame the converted lines break at their hard returns.
   - A piece's line has no space, so justify leaves it left (ADR-0077, unchanged).

## Model differences and known gaps

- **Illustrator is unverified.** If an Adobe source ever states another rule, this ADR is revisited, and the difference is named as ADR-0068 names its own.
- **Line positions.** A line that a larger range makes taller is placed by Illustrator's leading, and Inkscape's line box places it elsewhere, as ADR-0068 and ADR-0080 already record. In the leading-30 case above, Inkscape's pieces sit 35.09 apart and Kalamo's 30 apart. Each line holds the same characters in both.
- **A unit that ends a band unbroken** still sizes that band whole (#200). Inkscape stops measuring at the character that overflowed. The two differ only when a larger Character Range starts inside such a unit beyond that point. In `slant big-tail` at Auto, Kalamo's first band is 48 tall where Inkscape's is 24, so the lines after it differ.
- **A larger CJK run's box** is shorter in Inkscape under ADR-0080's run `line-height`. The four-box width can then be slightly smaller in Inkscape than in Kalamo.
- **Break opportunities.** Pango also breaks Latin text after `/` and hyphens, and Kalamo does not (ADR-0064's ponytail note). A URL therefore breaks at different places in the two editors (#222). Amended by ADR-0085: Kalamo breaks there too, so a URL is several units, and a unit breaks between characters only when it alone is wider than its span.

## What changes

The only layouts that change are those holding a unit that starts a span it does not fit, where the span is at least four line boxes wide. There are two kinds. In a rectangle, such a unit and everything after it overflowed, and now shows in pieces. In a shaped frame, such a unit skipped the span, and so that band or later ones, to a lower band that fit it. Now it breaks in the span. `TEXT_OVERFLOW` is no longer warned for such a unit's width alone. It is still warned when the pieces run past the frame's bottom.

#203's check, run again with each text laid out on `main` (3b1b722) and on this one: 60,000 random texts, in a rectangle 40 to 300 wide, a U, a triangle or a neck, with random sizes, tracking and fills in Character Ranges, leadings and alignments. Every text whose `layoutText`, `glyphs`, `pointType` or `areaFrame` changed holds a piece: a line that ends inside a unit. Its lines before the first piece are `main`'s line for line. Every other text gives the same values on both. The render golden and the `fixtures/documents/inkscape.svg` export snapshot do not change with the layout. They change only by the fixture's new "Wide Units" Artboard. `pnpm roundtrip` passes with that Artboard, a rectangle and a triangle whose words are wider than their frames, and Inkscape saves the same lines. The two texts differ by 5.22 % and 1.71 % of their 15 % budgets. Every other region prints `main`'s figures. Only the pixel count outside the Artboards shrinks by the new Artboard's area.

## Considered Options

- **Break only a unit that fits no later band.** This carries the 15-H word down past the 110-wide arm, where Inkscape breaks it, and so the file reads differently there. It also costs a look ahead at every band below.
- **Break in any span, however narrow.** This would split a word into a 30-wide neck that Inkscape skips (`neck`), and put a letter or two on each line of a narrow frame.
- **Keep the overflow.** It hides text that Inkscape shows. An Agent enlarging the frame's height would not bring it back.
