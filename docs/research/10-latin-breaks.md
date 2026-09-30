# Latin line breaks after solidus and hyphens (research notes, 2026-10-01)

For #222: where Inkscape 1.2.2 and Pango 1.50.12 break Latin text after `/`, `-` and BA, and what Kalamo's `lineBreakUnits` changes from `main` (2070333). Decision: ADR-0085.

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
