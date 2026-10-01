---
status: accepted
date: 2026-10-02
---

# Area Type breaks Latin text after EX, IN, B2 and ZWSP as Pango does

ADR-0085 broke Latin text after a solidus, a hyphen and BA, and left out four UAX #14 classes that Pango 1.50.12 also breaks at: EX (`!`, `?`), IN (`…`), B2 (`—`) and ZW (U+200B ZERO WIDTH SPACE). So `search?query=…` stayed one unit where Inkscape 1.2.2 breaks after the `?`. `word—word` and `wait…what` could not break, and in a frame narrower than ADR-0084's four line boxes, the rest of the text overflowed with `TEXT_OVERFLOW` where Inkscape shows it on the next line. A zero-width space that an author or an Agent inserted to allow a break did nothing (#225). This ADR adds those break opportunities. It amends ADR-0085's decision 4 and "Left out", and ADR-0087's decision 2.

## Evidence

`{ZW}` stands for U+200B, and `|` for a break opportunity.

**Pango 1.50.12 [M]**, `pango_get_log_attrs` through `docs/research/10-latin-breaks/pango.py`, measured on 2026-10-01 and 2026-10-02:

- EX: `Stop!|Go`, `x!!|y`, `x!|0`, `x!|%`, `x!|(y`, `x!|$5`, `x!-|y`, `https://|x.com/|search?|q=a&b=c`. No break: `x!)y`, `x?"y`, `x!␣y` (␣ is U+00A0).
- IN: `wait…|what`, `x……|y`, `x-…|y`, `1…|2`. No break: `x…)y`, `x…␣y`.
- B2: `word|—|word`, `a|——|b`, `a |—|b`, `a-|—|b`, `a)|—|b`, `a!|—|b`, `x|—|%`, `a|—́|b`. No break: `(—)`, `"—"`, `a␣—`, `א-—`. `a|— —|b` and `a|—  —|b` keep two em dashes together across spaces (LB17).
- ZW: `a{ZW}|b`, `a{ZW}{ZW}|b`, `a{ZW}|)b`, `a{ZW}|-|b`, `a{ZW}|␣b`, `a{ZW}|%`, `a {ZW}|b`, `a-{ZW}|b`. A combining mark after ZW starts a unit, `a{ZW}|́b`, and so does a word joiner, spaces between included: `a{ZW}|⁠b`, `a{ZW} |⁠b` (LB8 comes before LB9 and LB11).

GLib 2.74.6's classes in ASCII, Latin-1 and General Punctuation, the blocks ADR-0085 covers: EX is `!` and `?`; IN is U+2024–U+2026; B2 is U+2014; ZW is U+200B. Source Sans 3 draws all of them, and Kalamo measures U+200B at zero width.

**Inkscape 1.2.2 [M]**, `docs/research/10-latin-breaks/inkscape.mjs`, `<rect>` frames, 12 px Source Sans 3, as ADR-0085 measures them, lines from the saved line tspans:

| Width, text | Inkscape |
|---|---|
| 120, `See https://example.com/search?query=vector-editors for details.` | `See https://` · `example.com/search?` · `query=vector-editors ` · `for details.` |
| 45, `xxxx x!yyyyyy` | `xxxx x!` · `yyyyyy` |
| 45, `xxxx x…yyyyyy` | `xxxx x…` · `yyyyyy` |
| 45, `xxxx x—yyyyyy` | `xxxx x—` · `yyyyyy` |
| 45, `xxxx x{ZW}yyyyyy` | `xxxx x{ZW}` · `yyyyyy` |

On `main` (1d2243f), Kalamo gave `See https://` · `example.com/` · `search?query=vector-` · `editors for details.`, and `xxxx ` and then `x!yyyyyy` or `x{ZW}yyyyyy`, or an overflow of `x…yyyyyy` or `x—yyyyyy`. Every Inkscape line equals Pango's breaks, so Pango stays the oracle, as in ADR-0085.

**Illustrator [A]: unverified**, for the reasons ADR-0085 gives. Inkscape settles the rule.

## Decision

`lineBreakUnits` keeps its signature and join-back contract, and ADR-0085's flags and sets. The four classes are three more sets and two characters, not a pair table.

1. **EX, IN and B2 break after.** Between two non-space characters where neither is CJK, a line may break after `!`, `?`, U+2024–U+2026 and U+2014. The break is suppressed before a character that ADR-0064 keeps from starting a line, but `%`, as after a hyphen (`x!)y`, `x?"y`, `x!-|y`, `x……|y`, but `x!|%`), and before GL (`x!␣y`), as after a solidus.
2. **B2 breaks before.** A line may also break before U+2014, but after OP, QU, BB, GL or WJ (ADR-0064's no-break-after set) or another U+2014: `word|—|word`, `a|——|b`, `(—)`, `"—"`. After a hyphen or BA, ADR-0085's rules decide, so `a-|—` breaks and `א-—` does not. No break falls before U+2014 when the text before it is U+2014, its marks and U+0020s (LB17): `a|— —|b`.
3. **ZW breaks after**, before anything but another ZW, including a character that may not start a line: `a{ZW}|)b`, `a{ZW}|␣b`, `a{ZW}|-|b`. A unit never ends before ZW, a space before it included (LB7): `a {ZW}|b`. A word joiner after ZW and U+0020s starts a unit (LB8), and a combining mark after ZW starts one as a letter, its own base (LB8 before LB9).
4. **CJK is unchanged.** A pair with a CJK character is still decided by ADR-0064's flags alone, so `字{ZW}」` stays whole where Pango breaks, and fullwidth `！` and `？` keep ADR-0064's rules.
5. **Spaces are unchanged** but for LB7 and LB17 above. A break follows every other run of white space, so `a !` still gives `a ` · `! ` where Pango keeps `a !` (LB13 across a space).
6. **Everything downstream is unchanged**, as in ADR-0085's decision 5. ADR-0079's Convert to Point Type inserts a `\n` after each such break, and keeps a ZW that ends a line, since it is not white space.

## How it was checked

- **Pango's strings.** `text.test.ts` asserts Pango's units for every string above. ADR-0064's, ADR-0085's and ADR-0087's assertions are unchanged and pass.
- **Inkscape's frames.** `layoutText` gives Inkscape's lines for the five frames, with no overflow, each line's `start` a code point, and the lines joining back into `content`.
- **Random strings against Pango.** `docs/research/10-latin-breaks/check.ts`, with `!?…—` and U+200B added to the `latin` pool, and a rule that counts any difference after EX, IN, B2 or ZW, or before B2. `check.ts latin 1d2243f` prints:

  ```
  20000 strings, 2746 with a break that differs from Pango's
  1361 IS, CL, CP, PR or PO before NU, OP, PR or PO
  1235 a space before it: LB13 to LB16, across spaces
  367 a CJK neighbour: ADR-0064's pairs
  13 a space before a no-break space: LB13 to LB16, across spaces
  against 1d2243f: 5855 strings change at 7313 positions, 126 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango
  ```

  No difference falls after EX, IN, B2 or ZW, or before B2, but after a space. Counted first, ahead of the other rules, three positions there differ from Pango without a CJK neighbour, each `OP SP ÷ B2` such as `( —`, where Pango keeps the pair by LB14 across the space. Every changed position now equals Pango, and none has a CJK neighbour. Of the 126 removed breaks, 124 fall between a space and U+200B (LB7) and 2 between `— ` and `—` (LB17).
- **ADR-0064's alphabet.** `check.ts cjk 1d2243f` prints 3,232 strings that differ from Pango, at 2,497 IS, CL, CP, PR or PO positions, 901 after a space, 105 CL before a letter and 42 with a CJK neighbour. On `main`, 919 more positions differed as "EX before anything". All 919 change, each now a Pango break after `!` or `?`, and no position with a CJK neighbour changes: `against 1d2243f: 904 strings change at 919 positions, 0 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango`.
- **Layout from `main`.** #203's check, as ADR-0085 ran it: `docs/research/10-latin-breaks/regress.ts 1d2243f`, with `!`, `?`, `? `, `…`, `‥`, `—`, `——`, ` — `, U+200B, `!)` and `?{ZW}` added to its joins, prints `60000 texts, 52988 hold EX, IN, B2 or ZW; 24831 changed, 0 of them without one`.

## What changes

Every Area Type that holds `!`, `?`, U+2024–U+2026, U+2014 or U+200B can change its lines. The fixture's "Latin Breaks" Artboard widens from 440 to 590 to hold a fourth Area Type, `See example.com/find?query=vectors and wait—it answers.`, 12 pt in a rectangle 120 wide, which breaks after the `?` and before the `—`. The render golden and the `fixtures/documents/inkscape.svg` export snapshot change only by that text and the Artboard's width. `pnpm roundtrip` passes, Inkscape saves the same lines, and the text differs by 5.28 % of its 15 % budget. Every other text and Artboard region prints `main`'s figures. The Latin Breaks vector region grows from 13,500 to 17,564 pixels, and the region outside the Artboards shrinks by as many, since the Document's bounds do not change.

## Left out

- ZW beside CJK, such as `字{ZW}|」`, which ADR-0064's pairs decide.
- ZW before a tab: Pango breaks `a{ZW}|⇥b`, since a tab is BA, not SP. Kalamo never starts a unit with white space, which a line's hanging spaces rely on, so it gives `a{ZW}⇥` · `b`.
- EX, IN and B2 outside ASCII, Latin-1 and General Punctuation, such as `！` and `？`, which ADR-0064's CJK rules decide.
- Rules across spaces but LB7, LB8 and LB17: `a !`, `( —`.
- ADR-0085's other "Left out" items: U+00AD (amended by ADR-0094, which breaks after it), emoji as ID, IS, CL or CP before PR or OP (#226), BA outside the three blocks, UAX #14 rules newer than Pango 1.50.

## Considered Options

- **Add EX, IN, B2 and ZW to ADR-0085's break-after set.** That set yields to the no-break-before set, so `a{ZW}|)b` would stay whole (LB8), and `!` would break before GL as a hyphen does.
- **The full UAX #14 pair table.** It is what ADR-0085 names as the next step. These four classes still fit three sets and two characters, and no string measured here needed a pair the sets cannot express.
