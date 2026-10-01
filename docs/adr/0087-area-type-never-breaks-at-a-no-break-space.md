---
status: accepted
date: 2026-10-01
---

# Area Type never breaks at a no-break space

`lineBreakUnits` treated every character JavaScript's `/\s/` matches as white space that breaks. That set holds U+00A0 NO-BREAK SPACE, U+2007 FIGURE SPACE and U+202F NARROW NO-BREAK SPACE, which UAX #14 classes as GL, and U+FEFF, which it classes as WJ. Pango 1.50.12 never breaks after them, and Inkscape 1.2.2 wraps at Pango's breaks. So `10 km` or `Mr. Smith` typed with a no-break space split across lines in Kalamo and not in Inkscape. Convert to Point Type (ADR-0079) also tested a soft line's last character with `/\s/`, so it replaced a no-break space that ended a line with `\n`, deleted it from `content` and reported `discarded: 0` (#224). The rule came from ADR-0022's "greedy at spaces", and ADR-0064 and ADR-0085 kept it. This ADR amends ADR-0022's Wrapping bullet, ADR-0064's "Spaces break as before" bullet, ADR-0084's decision 2, and ADR-0085's decision 1 (the characters that suppress a break after), decision 4 and "How it was checked".

## Evidence

**Pango 1.50.12 [M]**, `pango_get_log_attrs` through `docs/research/10-latin-breaks/pango.py` (`|` is a break opportunity, ␣ is U+00A0): `a␣b |c`, `10␣km`, `a|␣b` never, `a |␣b`, `a-|␣b`, `a||␣b`, `a–|␣b`, `a␣/|b`, `a/␣b`, `1/␣2`, `a␣-|b`, `a␣ |b`, `a␣␣b`. U+2007, U+202F and U+FEFF between two letters stay whole, and so do `字␣字`, `a␣字`, `字␣a`, `$␣字`, `字␣%`, `「␣字` and `字␣」`; `字 |␣字` and `字-|␣字` break. U+FEFF and U+2060 keep a space before them: `a ﻿b` and `a ⁠b` are whole, and `a﻿ |b` breaks. This is UAX #14's LB11 (× WJ ×), LB12 (GL ×) and LB12a (`[^SP BA HY] × GL`). `text.test.ts` asserts each.

**Inkscape 1.2.2 [M]**, `docs/research/10-latin-breaks/inkscape.mjs`, frames 60 wide as ADR-0085 measures them, lines from the saved line tspans:

| Text | Inkscape |
|---|---|
| `xxxxx aa␣bbbbbbbb` | `xxxxx ` · `aa␣bbbbbb` · `bb` |
| `xxxxx 10␣km/h` | `xxxxx ` · `10␣km/h` |
| `xxxxx aa` U+202F `bbbbbbbb` | `xxxxx ` · `aa` U+202F `bbbbbbb` · `b` |
| `xxxxx aa` U+2007 `bbbbbbbb` | `xxxxx ` · `aa` U+2007 `bbbbbb` · `bb` |
| `xxxxx aaaaaaaaa␣bbbb`, `text-align:end` | `xxxxx ` at 33.24 · `aaaaaaaaa␣` at 5.568 · `bbbb` at 33.456 |
| the same with U+202F, U+2007, U+FEFF or U+0020 for ␣ | the same lines with that character, at the same `x` |
| `xxxxx aaaaaaaaaabbbb`, `text-align:end` | `xxxxx ` at 33.24 · `aaaaaaaaa` at 5.568 · `abbbb` at 27.408 |

The no-break space keeps each pair in one unit, which ADR-0084 breaks between characters when it is wider than its span. In the right-aligned frames, the second line starts at 5.568 whether `aaaaaaaaa` ends in U+00A0, U+202F, U+2007, U+FEFF, U+0020 or nothing, so each of the four hangs past the frame's edge as a space does. The bare line settles it: had the character not hung, the line would start further left by its advance, 5.964 for U+2007 at 12 px. U+FEFF has no advance, so its frame shows only that it does not break. U+2007 is the case that moved: `aaaaaaaaa` is 54.432 wide, and with U+2007 60.396, wider than the frame, so ADR-0084's prefix, which counted the trailing character, ended before it and started the next line with it.

**Illustrator [A]: unverified.** This host has no live Illustrator, and helpx.adobe.com returns 403 to it (ADR-0085). So Inkscape settles the rule, as ADR-0064, ADR-0084 and ADR-0085 let it settle what Adobe leaves open.

## Decision

1. **Which white space breaks.** `breakingSpace` in `line-break.ts` is every character `/\s/` matches but GL (U+00A0, U+2007, U+202F) and WJ (U+FEFF). A break follows each run of it, and a unit never starts with it. Tab, U+0020, U+1680, U+2000–U+2006, U+2008–U+200A, U+205F and U+3000 break as before.
2. **GL and WJ are ordinary characters for breaking.** No break falls after GL or WJ, nor before WJ, a space before it included. No break falls before GL unless a space, HY or BA comes before it, so `a |␣b`, `a-|␣b` and `a–|␣b` break and `a/␣b` does not. The CJK pairs follow the same rules: GL is in `NO_BREAK_AFTER`, and a CJK character never breaks before GL. `NO_BREAK_BEFORE` already held WJ. U+2060, the other WJ, follows the rule for WJ, and it was never white space.
3. **A no-break space still hangs.** `hangsFrom` keeps `/\s/`, because Inkscape hangs all four at a line's end as it hangs U+0020 (Evidence). Under decision 2, such a character ends a line only where ADR-0084 breaks a unit between characters, or before a breaking space, as in `a␣ |b`. ADR-0084's prefix is measured without its trailing white space, as a line is, so a no-break space that ends a piece stays on its line however wide it is.
4. **Convert to Point Type keeps it.** ADR-0079 replaces a soft line's last character with `\n` only when it is `breakingSpace`. After a no-break space it inserts `\n`, as after a character break, so removing the inserted returns gives back the old `content`.
5. **Everything else is unchanged.** ADR-0077's justify widens only U+0020. Point Type breaks only at hard returns. ADR-0085's Latin breaks and ADR-0064's CJK pairs give what they gave, but next to GL and WJ.

`lineBreakUnits` keeps its signature and join-back contract, and it keeps ADR-0085's flags and sets: GL and WJ are two more sets, not a class table.

## How it was checked

- **Pango's strings and Inkscape's frames.** `text.test.ts` asserts Pango's units for every string above, and ADR-0064's and ADR-0085's assertions are unchanged and pass. `layoutText` gives Inkscape's lines for the four left-aligned frames, with no overflow and the lines joining back into `content`. It gives Inkscape's lines and each line's `x` within 0.001 for the right-aligned frame with each of the four and with U+0020; before decision 3's prefix change, U+2007 started the third line instead.
- **Convert to Point Type.** `edit.test.ts` converts a 60-wide Area Type for each of the four characters where it ends a line at a character break. Each keeps it, and with the inserted `\n`s removed the new `content` equals the old. `xxxxx aa␣ bbbbbbbb` gives `xxxxx aa␣\nbbbbbbbb`.
- **Random strings against Pango.** `docs/research/10-latin-breaks/check.ts latin f14ce8c`, with U+00A0 and U+202F added to the `latin` pool, finds ten positions beside a no-break space that differ from Pango, and prints them on their own line. Each is a space before it, `OP SP ÷ GL` such as `( ␣` or `「 ␣`: Pango keeps it whole by LB14 across the space, and Kalamo breaks there as it breaks `( a`. That is #224's non-goal "LB13–LB16 across spaces" and ADR-0085's "Left out", so the issue's "no differing position before or after them" holds for every other rule, and not for these ten. They are the ten changed positions that the comparison with `main` counts as differing from Pango after a space; it finds no other changed position that differs from Pango. 5,114 strings change from `main` (f14ce8c), at 6,565 positions, 5,458 of them a removed break. The `cjk` pool holds no GL and does not change.
- **Layout from `main`.** #203's check, as ADR-0085 ran it: `docs/research/10-latin-breaks/regress.ts f14ce8c` with the four characters, ` ␣` and `-␣` added to its joins. Of 60,000 random Area Types, 51,730 hold one of the four characters, and 27,614 change their `layoutText`, `glyphs`, `pointType` or `areaFrame`. Every changed text holds one of the four. No fixture text holds one, so `pnpm roundtrip` prints `main`'s figures in every region.

## Considered Options

- **Stop hanging no-break spaces too, with one predicate for breaking and hanging.** #224's brief asked for this, one predicate at all three sites. It is simpler, but a right-aligned line that ends in a no-break space at a character break would sit left of Inkscape's by the character's advance: 2.4 pt for U+00A0, 1.44 for U+202F and 5.964 for U+2007 at 12 pt.
- **Treat GL as a letter everywhere.** This breaks `a/|␣b`, where Pango does not (LB12a).
- **The UAX #14 class table.** ADR-0085 keeps flags and sets until a few more classes are needed. GL and WJ are two sets.
