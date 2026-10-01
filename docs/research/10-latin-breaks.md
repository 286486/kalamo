# Latin line breaks after solidus and hyphens (research notes, 2026-10-01)

For #222: where Inkscape 1.2.2 and Pango 1.50.12 break Latin text after `/`, `-` and BA, and what Kalamo's `lineBreakUnits` changes from `main` (2070333). Decision: ADR-0085. #224 extends the same scripts to no-break spaces (ADR-0087), in its section, and #225 to EX, IN, B2 and ZW (ADR-0093), in the last. The figures before #224's section come from the scripts as #222 left them, at d6e0e0a, and #224's from the scripts at ad8d708.

Legend as in `06-illustrator-drawing-tools.md`: **[A]** the Adobe doc states it; **[M]** measured here. ADR-0085 records the Illustrator search, which is unverified.

Each script runs from the repo root and needs the tools named in its header: `inkscape` 1.2.2 for the frames, `python3` and `libpango-1.0.so.0` 1.50.12 for the Pango check, and git for the comparisons with `main`. Each writes its scratch files to `10-latin-breaks/out/`, which git ignores. The random strings and texts come from a fixed seed, so a rerun prints the same figures.

## Inkscape's frames [M]

`node docs/research/10-latin-breaks/inkscape.mjs` writes each of the ten frames as a `<rect>` Area Type, 12 px Source Sans 3 with the bundled fonts, has Inkscape save it, and prints each saved line tspan. It prints `10-latin-breaks/inkscape.tsv`, in a few seconds. `text.test.ts` asserts that `layoutText` gives the same lines for all ten.

## Pango's breaks on single strings [M]

The strings #222 measures one by one are the table in `text.test.ts`'s "breaks Latin after a solidus" test, which asserts Pango's units for each. `pango.py` prints Pango's units for any string, one JSON string per input line: `printf '"a-%%"\n"1/2"\n' | python3 docs/research/10-latin-breaks/pango.py` prints `["a-","%"]` and `["1/2"]`.

## Pango's breaks on random strings [M]

`node --experimental-transform-types docs/research/10-latin-breaks/check.ts <latin|cjk> 2070333` compares 20,000 random strings with `pango_get_log_attrs`, through `pango.py`, and counts each difference by the rule Kalamo leaves out. With the ref, it also compares with that ref's `line-break.ts`:

| Pool | Strings that differ from Pango | Differing positions, by rule | Change from 2070333 |
|---|---|---|---|
| `latin` | 3,424 | 1,981 IS, CL, CP, PR or PO before NU, OP, PR or PO; 1,519 after a space; 328 with a CJK neighbour | 6,392 strings at 7,327 positions |
| `cjk` | 3,994 | 2,497 IS, CL, CP, PR or PO before NU, OP, PR or PO; 919 EX; 901 after a space; 105 CL before a letter; 42 with a CJK neighbour | 1,211 strings at 1,250 positions |

In both pools, no difference from Pango falls after `/`, `-` or BA without a CJK neighbour. Every change from 2070333 adds a break at such a position, where Kalamo now equals Pango, and no break is removed. No changed position has a CJK neighbour, so ADR-0064's pairs give what they gave on `main`.

## Layout from `main` [M]

`node --experimental-transform-types docs/research/10-latin-breaks/regress.ts 2070333` extracts 2070333's `packages/core/src` and lays out 60,000 random Area Types with it and with this checkout's core, in about 20 seconds. It prints:

```
60000 texts, 54876 hold a new break-after character; 30784 changed, 0 of them without one
```

A text changes when its `layoutText`, `glyphs`, `pointType` or `areaFrame` differs. The other 29,216 give identical values.

## No-break spaces (#224) [M]

#224 asks where Pango and Inkscape break beside U+00A0, U+2007, U+202F and U+FEFF, and what ADR-0087 changes from `main` (f14ce8c). The same scripts measure it, each extended:

- `inkscape.mjs` adds ten frames: the four no-break frames of #224, 60 wide, and `xxxxx aaaaaaaaa␣bbbb` right-aligned with U+00A0, U+202F, U+2007, U+FEFF and U+0020 for ␣, and with nothing there (`aaaaaaaaaa`). It also prints each line tspan's `x`. Every right-aligned `aaaaaaaaa` line starts at 5.568, the bare one too, so Inkscape hangs each of the four as it hangs U+0020. Had it not, the U+2007 line would start 5.964 further left.
- `check.ts` adds U+00A0 and U+202F to the `latin` pool, and a rule for positions beside them, which it prints on their own line when a space comes before them. `check.ts latin f14ce8c` prints:

  ```
  20000 strings, 3014 with a break that differs from Pango's
  1752 IS, CL, CP, PR or PO before NU, OP, PR or PO
  1315 a space before it: LB13 to LB16, across spaces
  282 a CJK neighbour: ADR-0064's pairs
  10 a space before a no-break space: LB13 to LB16, across spaces
  against f14ce8c: 5114 strings change at 6565 positions, 5458 of them a removed break; 10 differ from Pango after a space (LB13 to LB16, across spaces); 0 others are not a Pango-matching break after / - or BA without a CJK neighbour or beside a no-break space
  ```

  Ten positions beside a no-break space differ from Pango, each a space before it: `OP SP ÷ GL`, such as `( ␣` and `「 ␣`. Pango keeps them whole by LB14 across the space, and Kalamo breaks there as it breaks `( a`, which #224 and ADR-0085 leave out. No other position beside a no-break space differs. They are the ten changed positions the comparison counts after a space. `check.ts cjk f14ce8c` changes nothing.
- `regress.ts` joins words with the four characters, ` ␣` and `-␣` too, and counts the texts that hold one. `regress.ts f14ce8c` prints:

  ```
  60000 texts, 51730 hold a no-break space or U+FEFF; 27614 changed, 0 of them without one
  ```

## EX, IN, B2 and ZW (#225) [M]

#225 asks where Pango and Inkscape break after `!`, `?`, U+2024–U+2026, U+2014 and U+200B, and before U+2014, and what ADR-0093 changes from `main` (1d2243f). The same scripts measure it, each extended again:

- `inkscape.mjs` adds #225's five frames: the `search?query=` URL sentence 120 wide, and `xxxx x!yyyyyy`, `xxxx x…yyyyyy`, `xxxx x—yyyyyy` and `xxxx x` U+200B `yyyyyy` 45 wide. Inkscape breaks after `?`, `!`, `…`, `—` and U+200B, and `text.test.ts` asserts the same lines.
- `check.ts` adds `!?…—` and U+200B to the `latin` pool, a rule for positions after EX, IN, B2 or ZW or before B2, and, with a ref, counts the changed positions with a CJK neighbour and those that now differ from Pango. `check.ts latin 1d2243f` prints:

  ```
  20000 strings, 2746 with a break that differs from Pango's
  1361 IS, CL, CP, PR or PO before NU, OP, PR or PO
  1235 a space before it: LB13 to LB16, across spaces
  367 a CJK neighbour: ADR-0064's pairs
  13 a space before a no-break space: LB13 to LB16, across spaces
  against 1d2243f: 5855 strings change at 7313 positions, 126 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango
  ```

  The new rule counts nothing. Moved ahead of the space and CJK rules, it counts three positions without a CJK neighbour, each `OP SP ÷ B2` such as `( —`, LB14 across a space. Of the removed breaks, 124 fall between a space and U+200B (LB7) and 2 between `— ` and `—` (LB17). `check.ts cjk 1d2243f` prints 3,232 differing strings, at 2,497 IS, CL, CP, PR or PO positions, 901 after a space, 105 CL before a letter and 42 with a CJK neighbour: the 919 "EX before anything" positions of `main` are gone, `against 1d2243f: 904 strings change at 919 positions, 0 of them a removed break; 0 with a CJK neighbour; 0 now differ from Pango`.
- `regress.ts` joins words with `!`, `?`, `? `, `…`, `‥`, `—`, `——`, ` — `, U+200B, `!)` and `?` U+200B too, and counts the texts that hold EX, IN, B2 or ZW. `regress.ts 1d2243f` prints:

  ```
  60000 texts, 52988 hold EX, IN, B2 or ZW; 24831 changed, 0 of them without one
  ```
