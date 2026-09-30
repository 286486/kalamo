---
status: accepted
date: 2026-09-30
---

# Rectangular Area Type lays out through the band filler

Rectangular Area Type (ADR-0022) and shaped Area Type (ADR-0078) broke lines in two greedy fills. #202 gave both fills one unit list. The rectangle's fill was the one-span case of the shaped fill except in three rules (#203). This ADR decides each rule from Inkscape 1.2.2 measurements in a `<rect>` `shape-inside` and from Illustrator's documented rules. It then deletes the rectangle's fill, so one filler lays out both frame kinds. The measurements are in `docs/research/09-shaped-bands.md`, section "A rectangle frame (#203)". This ADR amends ADR-0022's Overflow bullet, ADR-0068's Area Type bullet, ADR-0079's `height`, and ADR-0080's "Show and overflow".

## Decision

A rectangle frame is a shaped frame whose every band is one span, the frame's width, as long as the band lies in the frame. `layoutText` fills both kinds with the band filler that ADR-0078's #200 amendment describes. For each of the three rules:

1. **A unit wider than the frame: unified, no change.** A shaped band skips a unit that fits none of its spans, and the next band tries it one leading lower. In a rectangle every band has the same span, so the unit fits no band down to the frame's bottom. It and everything after it overflow, which is ADR-0022's rule. The layout is the same line for line, and no parameter is needed. Inkscape 1.2.2 does something else here: it breaks the unit between characters, in a `<rect>` and in every path frame measured. So ADR-0022's "as in Inkscape" is wrong for 1.2.2. Illustrator also breaks the word (ADR-0022's Considered Options; unverified, since no Adobe source states it, ADR-0084). Breaking it would change both frame kinds, so it is #221's work, not this refactor's. Amended by ADR-0084: in both frame kinds, a unit that starts a span it does not fit breaks there between grapheme clusters when the span is at least four line boxes wide.
2. **What sizes a line: kept as a parameter of the rectangle frame.** A shaped band is sized by every unit it tries, including the unit it could not fit (#200). A rectangle's line is sized by the characters it holds, as before. That is Illustrator's rule: a line's leading is the largest leading on the line (ADR-0068). Inkscape sizes a rectangle's line by the larger word it could not fit, as it does in any frame. The first line of `rect big-5th` sits at 74.17 at Auto, where the characters it holds give 57.08. A shaped frame follows Inkscape because a band's height changes its width, and so which words it takes. A rectangle's width does not follow its height, so Kalamo and Inkscape put the same words on every line under either rule: 3, 3, 4, 2 for `big-4th` and 4, 3, 4, 2 for `big-5th`, at Auto and at leading 30. The only difference is where the lines sit, which is ADR-0068's model difference. So nothing pulls the rectangle off Illustrator's rule.
3. **The overflow threshold: unified, a named change.** A rectangle's line now shows while its band lies in the frame. The band is the line's box less a tenth of its height at its top and bottom, reaching at least the text's strut's bottom (ADR-0078's #200 amendment). The line's box is the one sized in rule 2. For every line whose box reaches at least as low as the strut, including every text of one size, this is ADR-0022's rule: 90 % of its leading, measured from its top. The rules differ only when the strut reaches lower. That happens for a larger size under a set leading, and for a smaller size with Auto. Inkscape's threshold, measured for a one-line text, follows the band:

   | First line in a 20 px text | Inkscape shows it from | Band rule | ADR-0022's 90 % |
   |---|---|---|---|
   | 20 px, Auto / 30 | 21.601 / 26.999 | 21.600 / 27.000 | the same |
   | 40 px, Auto | 43.200 | 43.200 | 43.200 |
   | 40 px, leading 30 | 31.575 | 31.575 | 27.000 |
   | 10 px, Auto | 21.601 | 13.913 | 10.800 |
   | 10 px, leading 30 | 29.288 | 27.000 | 27.000 |

   In a frame between 27 and 31.575 tall, the old rule showed the 40 px line where Inkscape hides it, so a saved file showed a line in Kalamo that Inkscape did not draw. The 10 px lines are ADR-0080's first-baseline model difference. Inkscape's line box holds the strut's ascent too, so at Auto its baseline is 17.08 below the top, and Kalamo's is 8.54. The band rule narrows that gap at Auto. At leading 30 the 10 px box already reaches below the strut, so the two rules agree. Illustrator documents no overflow threshold. Kalamo's rectangle threshold was always Inkscape's (ADR-0022), so Inkscape settles it here as well.

   A line whose band would end above the frame's bottom only at a larger size is sized first. Under a set leading a larger size can end the band higher, since its box's larger tenth comes off a descent that the strut fixes. So a rectangle's line is sized by the characters it holds, then tested once against the frame's bottom, with ADR-0022's billionth-of-a-leading tolerance. A shaped band stops, as before, when its top passes the frame's bottom.

**Convert to Area Type** (ADR-0079) makes the frame reach each line's band bottom where that is lower than its line box's bottom. So Point to Area still never warns `TEXT_OVERFLOW`. The frame is unchanged for one size.

## Unchanged

- Every text of one size, and every text in which each line's box reaches at least as low as the strut. That covers rectangular Area Type, Convert to Area Type and Convert to Point Type, all-Latin and all-CJK alike.
- Every shaped Area Type.
- Point Type, the SVG form, import and export.

#202's check, run again: 40,000 random texts laid out by this layout and by `main`, of either kind, in a rectangle, a U or a triangle, with and without ranges that set sizes, tracking and fills. `layoutText`, `glyphs`, `pointType` and `areaFrame` return the same values for every text with no size range and for every shaped frame. In the mixed-size rectangles that changed, the new lines are the old lines with trailing lines removed. In a justified one, the new last line also loses its word spacing, its glyphs closing up to their unwidened positions, since a justified Area Type's last line is not widened (ADR-0077). In the mixed-size conversions that changed, only the frame's `height` grows, and the converted text shows every line. `pnpm roundtrip` prints the same per-region figures as `main`, byte for byte. The render golden and the `fixtures/documents/inkscape.svg` export snapshot do not change.

## Considered Options

- **Keep two fills.** Each new rule, such as #221's mid-word break, would need writing twice, and the two copies drift.
- **Size a rectangle's line by every unit it tries, as a shaped band is sized.** This would move rectangle lines to Inkscape's positions on the lines a larger word makes taller, but off Illustrator's documented leading (ADR-0068, ADR-0080). It changes no break, so nothing in the round trip asks for it.
- **Keep the 90 % threshold as a parameter of the rectangle frame.** This keeps a rule that shows lines Inkscape hides, and it is no closer to Illustrator.

## Consequences

- `text.ts` has one Area Type filler, `area`. `stack` gives only the baseline, and `lineBoxes` gives each line's band. The rectangle's fill, `stack`'s `needs` and the shaped branch's own strut code are gone.
- The ADR-0068 test for a line holding a larger size now expects the band threshold. The ADR-0079 test for a larger last line under a set leading covers Convert to Area Type's taller frame.
- #221 records Inkscape's mid-word break for Area Type of both kinds.
