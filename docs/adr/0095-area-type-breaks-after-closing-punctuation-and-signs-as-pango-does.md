---
status: accepted
date: 2026-10-02
---

# Area Type breaks after closing punctuation and signs as Pango does

ADR-0085 left out "IS, CL or CP before PR or OP, and PR or PO before PR, PO or OP". Kalamo kept `f(x)(y)`, `C:\Users\x` and `a,$5` whole where Pango 1.50.12 and Inkscape 1.2.2 break them. A frame narrower than ADR-0084's `minBreakWidth` then hid `a)(bbbbb` as overflow, with `TEXT_OVERFLOW`, where Inkscape shows `(bbbbb` on the next line (#226). It was the largest difference `check.ts` found. This ADR adds those break opportunities and keeps LB25's number whole. It amends ADR-0085's decision 1, its state and its "Left out".

## Evidence

`|` stands for a break opportunity.

**Pango 1.50.12 [M]**, `pango_get_log_attrs` through `docs/research/10-latin-breaks/pango.py`, measured on 2026-10-01 and 2026-10-02.

- #226's strings. Breaks: `a)|(b`, `f(x)|(y)`, `a]|[`, `x:|(y`, `a,|$5`, `C:|\x`, `$|$`, `%|%`, `a)|$`, `5%|$`, `a,|0`, `a.|5`, `a:|0`. No break: `1)$`, `1,0`, `(1)2`, `1)2`, `a)1`, `$5`, `5%`.
- GLib 2.74.6 classes `]` as CP, as `)`, and only `}` as CL in ASCII. So `x]y` and `a]1` stay whole (LB30), and `x}|y`, `x}|1`, `1}|5`, `x}|#` and `x}|א` break.
- LB25 is UAX #14's Example 7 tailoring, not its pair list. A number `NU (NU | SY | IS)*` keeps one CL or CP after it, and either keeps a PR or PO after it: `1,$`, `1.%`, `1,)$`, `1:)%`, `a1)$`, `1}$` stay whole, and `1)]|$`, `1),|$`, `1),|5` and `1a)|$` break. A PR or PO keeps an OP before a digit: `$(5`, `%{5` and `$[5` stay whole, and `$|(a`, `$|((5`, `$|(-5` break. `$|+5` and `+|$5` break, as PR before PR.
- IS, CP, PR and PO keep a letter after them (LB24, LB29, LB30): `a.א`, `a)א`, `a$5`, `a%5`. A combining mark takes its base's class: `a$◌́|(`, `a,◌́|5`, and `a$◌́(5`, `1◌́,5`, `1)◌́$` stay whole.
- No break before GL, QU or WJ: `a]␣b`, `a,␣b`, `$␣b` (␣ is U+00A0), `x}"`, `x}⁠y`.

**Inkscape 1.2.2 [M]**: `<rect>` frames, 12 px Source Sans 3, as `docs/research/10-latin-breaks/inkscape.mjs` writes them, saved through Inkscape on 2026-10-02:

| Width, text | Inkscape | Kalamo on `main` (9d032c7) |
|---|---|---|
| 45, `xxxx a)(bbbbb` | `xxxx a)` · `(bbbbb` | `xxxx `, overflow `a)(bbbbb` |
| 45, `xxxx a,$5555` | `xxxx a,` · `$5555` | `xxxx ` · `a,$5555` |
| 60, `Open C:\Users\x now` | `Open C:` · `\Users\x ` · `now` | `Open ` · `C:\Users\x ` · `now` |

**Illustrator [A]: unverified**, as ADR-0085 records. Inkscape settles the rule.

## Decision

`lineBreakUnits` keeps its signature and contract.

1. **After IS, CL, CP, PR and PO.** Between two non-space characters where neither is CJK, after IS (`,.:;`), CP (`)`, `]`), CL (`}`), or ADR-0064's PR and PO sets:
   - before PR or PO, a line breaks unless a number, or a number and one CL or CP, ends at the breaker (LB25): `a,|$5`, `5%|$`, `C:|\x`, and `1,$`, `1)%` stay whole;
   - before OP (`([{`), a line breaks, but after PR or PO before a digit (LB25): `a)|(b`, `x:|(y`, `$|(a`, and `$(5` stays whole;
   - before a digit, a line breaks after IS that does not continue a number (LB25) and after CL: `a,|0`, `x}|1`. It does not after IS inside a number, CP (LB30), PR or PO (LB25): `1,0`, `a)1`, `$5`;
   - before anything else, a line breaks after CL alone, unless ADR-0064 keeps the next character from starting a line, or it is GL: `x}|y`. IS, CP, PR and PO keep a letter (LB24, LB29, LB30).
2. **The number state** grows from ADR-0085's flag to three values: the text so far ends in `NU (NU | SY | IS)*`, ends in that and one CL or CP, or ends in neither. A solidus and IS continue only the first, so `1)/2` still breaks. A combining mark leaves it as its base left it (LB9).
3. **One character of lookahead** decides PR or PO before OP. The rule reads the character right after the OP, as Pango does: `$|(◌́5`, with a mark between, breaks in both.
4. **CJK is unchanged.** A pair with a CJK character is decided by ADR-0064's flags alone, as on `main`.
5. **No pair table.** Every Pango string #226 names is met with ADR-0085's flags and the three-valued number state. So `breaksAfter` keeps its sets, and the UAX #14 pair table stays a considered option.

Everything downstream is unchanged, as in ADR-0085's decision 5.

## How it was checked

- **Pango's strings.** `text.test.ts` asserts Pango's units for every string above. ADR-0064's, ADR-0085's, ADR-0087's, ADR-0093's and ADR-0094's assertions are unchanged and pass.
- **Inkscape's frames.** `layoutText` gives Inkscape's lines for the three frames, with `overflow` empty and the lines joining back into `content`. `inkscape.mjs` adds them to `inkscape.tsv`.
- **Random strings against Pango.** `check.ts latin 9d032c7` prints:

  ```
  20000 strings, 1518 with a break that differs from Pango's
  1183 a space before it: LB13 to LB16, across spaces
  372 a CJK neighbour: ADR-0064's pairs
  9 a space before a no-break space: LB13 to LB16, across spaces
  against 9d032c7: 1242 strings change at 1311 positions, 0 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango
  ```

  `check.ts cjk 9d032c7` prints 928 differing strings, at 901 positions after a space and 42 with a CJK neighbour, and `against 9d032c7: 2434 strings change at 2602 positions, 0 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango`. The "IS, CL, CP, PR or PO before NU, OP, PR or PO" bucket (1,311 `latin`, 2,497 `cjk` on 9d032c7) and the `cjk` pool's 105 "CL before a letter" are gone. The positions with a CJK neighbour are those of `main`.

## What changes

Every Area Type that holds IS, CL, CP, PR or PO can change its lines. `regress.ts 9d032c7`, #203's check with words also joined by `)(`, `](`, `}`, `,$`, `:\`, `:`, `.`, `,`, `$`, `%`, `%$`, `$$`, `)$`, `(`, `)` and `}(`, prints:

```
60000 texts, 53159 hold IS, CP, CL, PR or PO; 21682 changed, 0 of them without one
```

No fixture text changes its lines. The render golden and the export snapshots are unchanged, and `pnpm roundtrip` prints `main`'s figures for every region.

## Left out

- Emoji as ID, after these classes too: Pango breaks `a)|🙂`, `a,|🙂` and `a%|🙂`, and keeps `a$🙂` (LB23a).
- OP, CL, CP and IS outside ASCII, such as `¿`, `¡`, `‚`, `„` and `⁅`.
- LB25's other number rules, rules across spaces, and the rest ADR-0085 leaves out.

## Considered Options

- **The full UAX #14 pair table.** It would replace `breaksAfter`'s Latin rules. #226 allows it only if a Pango string cannot be met otherwise, and every one can. It stays the point to switch when a few more classes come.
- **Keep ADR-0085's two-valued number flag.** `1)$` and `1}$` then break, where Pango keeps a number's closing bracket and sign whole.
