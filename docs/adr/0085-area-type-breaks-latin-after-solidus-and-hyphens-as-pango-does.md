---
status: accepted
date: 2026-10-01
---

# Area Type breaks Latin text after solidus and hyphens as Pango does

Area Type broke Latin text only at spaces (ADR-0064, "Spaces break as before"). Inkscape 1.2.2 wraps with Pango 1.50.12, which also breaks after a solidus, after a hyphen-minus and after UAX #14's BA characters, such as the en dash and `|`. A URL, a path or a hyphenated word at a line's end therefore broke in different places in Kalamo and in Inkscape. A URL was one unit, and ADR-0084's character break split it mid-segment (`https://example.com/a` · `/very/long/path/that/fit` · …), where Inkscape breaks after a `/` (#222). This ADR adds those break opportunities. It amends ADR-0064's "Spaces break as before" bullet, its "Left out" list and its Considered Options, and ADR-0084's "Break opportunities" gap.

## Evidence

**Inkscape 1.2.2 [M].** A `<rect>` frame, 12 px Source Sans 3, `font-kerning:none`, `line-height:1.2`, with the bundled fonts through `fonts.conf` as `pnpm roundtrip` sets them, saved through Inkscape. Each line is read from its line tspan. The lines are measured on 2026-09-30. `docs/research/10-latin-breaks/inkscape.mjs` reruns the ten frames and prints them as `inkscape.tsv` (`docs/research/10-latin-breaks.md`). At width 120, `See https://example.com/a/very/long/path/that/fits/no/line for details.` gives `See https://` · `example.com/a/very/` · `long/path/that/fits/no/` · `line for details.`. Nine more frames, from 40 to 60 wide, cover `well-known state-of-the-art`, an en dash, `|`, a hyphen before `(`, `$` and a digit, a combining mark after a hyphen, and a solidus before a number. Every line equals the break opportunities that `pango_get_log_attrs` gives. So Pango's table is the oracle, and Inkscape wraps at it.

**Pango 1.50.12 [M]** (`libpango-1.0.so.0.5000.12`, GLib 2.74.6's line-break classes), called through `pango_get_log_attrs` with language `en` by `docs/research/10-latin-breaks/pango.py`. #222 lists every string measured. In GLib's classes, SY is U+002F only and HY is U+002D only. BA in ASCII, Latin-1 and General Punctuation is U+0009, U+007C, U+00AD, U+2000–2006, U+2008–200A, U+2010, U+2012, U+2013, U+2027, U+2056, U+2058–205B and U+205D–205F. U+0009 and the spaces among them already break as white space.

**Illustrator [A]: unverified.** Adobe's "Set hyphenation and line breaks in Illustrator" and "Insert white space and break characters in Illustrator" describe hyphenation, the composers, No Break and discretionary hyphens. Neither says whether Area Type may break after `/` or an explicit hyphen. They were searched on 2026-09-30. helpx.adobe.com returns 403 to this host, so the pages were read through the search index. This host has no live Illustrator to check against. So Inkscape settles the rule, as ADR-0064 and ADR-0084 let it settle what Adobe leaves open. If an Adobe source later states otherwise, this ADR records the difference.

## Decision

`lineBreakUnits` keeps its signature and contract. It returns units in order, each ending at a break opportunity and keeping the spaces after it, and they join back into the paragraph. `layoutText`, `glyphs`, the canvas, SVG export, `io` and MCP call it unchanged.

1. **Break after.** Between two non-space characters where neither is CJK, a line may break after SY (`/`), HY (`-`) and BA in ASCII, Latin-1 and General Punctuation: `|`, U+2010, U+2012, U+2013, U+2027, U+2056, U+2058–205B, U+205D and U+205E. The other BA characters are spaces, which break already. Amended by ADR-0094: U+00AD, first left out as hyphenation, breaks after too, and takes no width. The break is suppressed, as Pango 1.50.12 suppresses it, when:
   - the next character is one that ADR-0064 keeps from starting a line (CL, CP, EX, IS, SY, NS, CJ, IN, BA, HY, QU, GL, WJ, ZW, CM), but `%`, which is PO and breaks: `a--b`, `a//b`, `a-)`, `a/"`, `a-.`, `a-!` stay whole, and `a-|%` breaks. Amended by ADR-0087: before GL, only a solidus suppresses the break, so `a/␣b` stays whole and `a-|␣b` and `a–|␣b` break;
   - a hyphen comes before a decimal digit (LB25): `a-1`, `-5`, `1-2`, `2026-09-30`;
   - a solidus continues a number, that is it follows `NU (NU | SY | IS)*`, and a digit, PR or PO comes after it (LB25): `1/2`, `1.2/3`, `a1/2`, `1/$` stay whole, and `a/1`, `1a/2`, `1)/2`, `1)/%` break;
   - a hyphen or BA follows a Hebrew letter (LB21a), or a solidus comes before one (LB21b): `א-ב`, `א/ב`, `a/ב`.

   Otherwise it breaks, also before OP, PR, PO, a letter, a digit after a solidus, an ideograph and an emoji: `a-|(b)`, `a-|$5`, `a-|€`, `a-|😀`, `a/|字`.
2. **Combining marks** take their base's class (LB9). The rule looks at the base before the marks, and the break falls after the last mark: `a-◌́|b`. A break never falls before a mark, so no grapheme cluster is split.
3. **CJK is unchanged.** A pair with a CJK character is decided by ADR-0064's flags alone. The one CJK-adjacent change is intended: `字-|a` and `字/|a` now break, because the pair `-a` has no CJK character. Pango breaks there, and `a-|字` and `a/|字` already broke.
4. **Spaces are unchanged.** A break follows every run of white space, trailing spaces hang, and a unit never starts with a space. So `a /b` gives `a ` · `/` · `b`. Pango keeps `a /` together (LB13 applies across the space), and ADR-0064 leaves that rule out. Amended by ADR-0087: the white space that breaks is every character `/\s/` matches but GL (U+00A0, U+2007, U+202F) and WJ (U+FEFF). No break falls after GL or WJ or before WJ, and a break falls before GL only after a space, HY or BA. At a line's end, all four hang as a space does. Amended by ADR-0093: no break falls between a space and U+200B (LB7), nor before U+2014 when U+2014 and U+0020s come before it (LB17).
5. **Everything downstream is unchanged.** A unit is still unbreakable in ADR-0064's sense, so a URL is several units. ADR-0084's character break applies only when one of those units is wider than its span, so `xxxxx 12/12345678` at 60 still gives `xxxxx ` · `12/1234567` · `8`, as Inkscape does. ADR-0077's justify widens only U+0020, so a line that ends after `/` with no space stays left, as a piece does. ADR-0079's Convert to Point Type inserts a `\n` after each such break, as after a CJK break. ADR-0022's overflow and `TEXT_OVERFLOW` do not change.

The state is two values beside the previous character: the base before the current marks with the base before it, for LB9 and LB21a, and whether the text so far ends in `NU (NU | SY | IS)*`, for LB25. Amended by ADR-0095: the number state also says whether the text ends in such a number and one CL or CP, and IS, CL, CP, PR and PO break before OP, PR, PO and NU.

## How it was checked

- **Pango's strings.** Every string #222 lists gives Pango's units in `text.test.ts`, but `a /b` (decision 4). The ADR-0064 assertions are unchanged and pass.
- **Inkscape's frames.** `layoutText` gives Inkscape's lines for all ten frames, each line's `start` a code point, and the lines join back into `content`.
- **Random strings against Pango.** `docs/research/10-latin-breaks/check.ts` compares 20,000 random strings with Pango. The `latin` strings draw from Latin letters, digits, spaces, `/-–‐‒|()"'.,$%`, a combining mark, two Hebrew letters and CJK characters and punctuation. At every position after `/`, `-` or BA without a CJK neighbour, Kalamo equals Pango. 3,424 strings differ elsewhere, all by rules this ADR leaves out:
  - 1,981 positions where IS, CL, CP, PR or PO comes before NU, OP, PR or PO. Pango breaks `,|0`, `)|(`, `$|$` and `%|%`, and Kalamo does not.
  - 1,519 positions after a space: LB13 to LB16 across spaces, such as `a |,` and `a |/`.
  - 328 positions with a CJK neighbour, all as on `main`: a combining mark after an ideograph, CJK punctuation beside PR or PO, and a dash after a Hebrew letter before CJK.
- **ADR-0064's alphabet.** 20,000 random strings from CJK, kana, Hangul, CJK and ASCII punctuation, Latin letters and digits. 1,211 strings change from `main`, and every changed position is a break after `/`, `-` or `|` with no CJK neighbour, where Kalamo now equals Pango. No position with a CJK neighbour changes. The `latin` strings give the same result: 6,392 change, all at such breaks. `check.ts <pool> 2070333` prints these counts beside Pango's, from 2070333's `line-break.ts` and this one's.

Amended by ADR-0087: #224 extended `check.ts`, `regress.ts` and `inkscape.mjs` in place, so the figures above and in "What changes" come from the scripts and `packages/core/src` at d6e0e0a, the last commit of #222. `git worktree add --detach <dir> d6e0e0a` and the same commands in `<dir>` print them unchanged, rerun on 2026-10-01.

## What changes

Every Area Type that holds `/`, `-` or a listed BA character can change its lines, where such a character can now end a line. #203's check, run as ADR-0084 ran it by `docs/research/10-latin-breaks/regress.ts 2070333`, on 60,000 random Area Types laid out on `main` (2070333) and with this change: rectangles 40 to 300 wide, a U, a triangle and a neck, words joined by spaces, returns, `/`, `-`, `–`, `‐`, `‒`, `|`, `‧` and `, `, with random sizes, tracking and fills in Character Ranges, leadings and alignments. 30,784 texts change their `layoutText`, `glyphs`, `pointType` or `areaFrame`, and every one holds a character in the new break-after set. The other 29,216 give identical values.

The render golden and the `fixtures/documents/inkscape.svg` export snapshot change only by the fixture's new "Latin Breaks" Artboard, below the others. It holds the URL sentence and `state-of-the-art well-known 2026-09-30 and/or`, each 12 pt in a rectangle 120 wide. `pnpm roundtrip` passes, and Inkscape saves the same lines. The two texts differ by 11.04 % and 5.92 % of their 15 % budgets. Every other region prints `main`'s figures. Only the pixel count outside the Artboards grows, because the Document is now taller.

## Left out

Each of these is a Pango Latin break that Kalamo does not give, measured on 2026-09-30. Each needs its own class in `line-break.ts`, and they can be filed as a follow-up:

- EX: `x!|y`, `c?|d`. IN: `x…|y`. B2: `a|—|b`. Emoji as ID: `x|🙂|y`. ZWSP as a break opportunity. Amended by ADR-0093: EX, IN, B2 and ZWSP now break in ASCII, Latin-1 and General Punctuation, and emoji as ID is still left out.
- IS, CL or CP before PR or OP, and PR or PO before PR, PO or OP: `C:|\x`, `a)|(b`, `a,|$5`, `$|$`. Amended by ADR-0095: these now break, and LB25 keeps a number, one closing bracket after it and its signs whole.
- Fullwidth forms beside Latin, such as `a|－|b`. These belong to ADR-0064's CJK rules.
- BA outside ASCII, Latin-1 and General Punctuation, such as Indic danda, Tibetan, Ethiopic and Supplemental Punctuation.
- UAX #14 rules newer than Pango 1.50, such as Unicode 15.1's LB20a, which forbids a break after a word-initial hyphen. Pango 1.50 breaks `-|a` and `a |-|b`, and so does Kalamo.
- Rules across spaces (LB13 after a space, LB14 to LB16), and LB25's rules other than HY before NU and SY inside a number.
- Illustrator's composers, No Break and discretionary hyphens.

## Considered Options

- **The full UAX #14 pair table.** It would give the left-out breaks too. But no requirement needs them yet, and they would change Latin wrapping around `!`, `…`, `—` and emoji beyond what #222 measured. The flags and sets stay smaller, and a few more classes are the point to switch.
- **Break after `/` and `-` without suppressions.** This splits `2026-09-30`, `1/2` and `a-)` where Pango and Inkscape keep them whole.
- **Keep breaking Latin at spaces only.** The same file then keeps reading differently in Kalamo and in Inkscape.
