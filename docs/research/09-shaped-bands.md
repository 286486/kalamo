# Shaped Area Type bands whose lines mix sizes (research notes, 2026-09-30)

For #200 and #203: how tall a band of a shaped Area Type (ADR-0078) is when its line holds a larger Character Range or CJK in a fallback family, where it sits, and which words it takes. Decision: ADR-0078's #200 amendment, and for a rectangle frame ADR-0083. The stacking rule itself is ADR-0080's.

Legend as in `06-illustrator-drawing-tools.md`: **[A]** the Adobe doc states it; **[M]** measured here.

## Illustrator

Access note: helpx.adobe.com returns 403 to WebFetch and to `curl` from this host on 2026-09-30, as `08-line-stacking.md` records. The sentences are quoted from the search index's extract of the live pages.

- **[A]** "Add text and work with type objects", https://helpx.adobe.com/illustrator/using/add-text-work-with-type-objects.html: "Area type (also called paragraph type) uses the boundaries of an object to control the flow of characters, either horizontally or vertically. When the text reaches the border, it automatically wraps to fit inside the defined area."
- **[A]** "Line and character spacing in Illustrator", https://helpx.adobe.com/illustrator/using/line-character-spacing.html: "Leading is measured from the baseline of one line of text to the baseline of the line above it." "The default auto-leading option sets the leading at 120% of the typeface size." ADR-0068 records the rest as Kalamo follows it: the largest leading on a line sets the line's leading.

**The rule they give.** A shaped frame only bounds where each line may run. A line's baseline is its leading below the previous line's, the same as in a rectangle frame, and a larger Character Range raises that line's leading. So a shaped band steps exactly as ADR-0080 steps a rectangle frame's line.

**What they leave open.** No passage says how tall a strip of the shape a line's width is measured over, whether it is the full line box or a narrower one, or how a taller line narrows the width it can use. None says what happens when a larger word does not fit a line: whether it still makes the line taller. None says how far down the next try goes when no part of a line's strip is wide enough. Each gap is settled below by Inkscape 1.2.2, which draws the exported file. Checking Illustrator itself needs a live copy, which this host does not have.

## Inkscape 1.2.2

`09-shaped-bands/probe.mjs` writes each case as an SVG under `09-shaped-bands/out/` and runs `inkscape --query-all` on it with the bundled fonts, through a `fonts.conf` built as `pnpm roundtrip` builds its own. Reproduce with `node docs/research/09-shaped-bands/probe.mjs`, which prints `results.tsv` in a few seconds.

The text is 20 px Source Sans 3 flowed with `shape-inside` in a `<path>`, Auto leading (`line-height:1.2`) or leading 30 (`30px`). Every word is a tspan of its own. A word of H's gives its line's baseline, the bottom of its ink, and its origin, its ink's left less the H's side bearing of 0.09 em. A CJK word is one `字`, which falls back to Noto Sans SC and carries ADR-0080's run `line-height`, as export writes it. Its baseline is read as its ink's bottom less 0.0791 em, calibrated on the U frame. `results.tsv` lists each drawn line: frame, text, leading, baseline, and each word as `index[@size][cjk]:x`.

**Frames** (`FRAMES`): `U`, a concave frame whose arms, 120 wide and 80 deep, give each band two spans; `triangle`, whose bands narrow downward; `slant`, whose left edge is `x = 20 + (y − 40) / 3`, so a line starts where the edge is at its band's bottom; `neck`, 30 wide above y 100, too narrow for any word; `rect`, a `<rect>` 180 wide and 300 tall from (20, 40), written as export writes a rectangular Area Type's frame (#203).

**Texts** (`TEXTS`): `heading`, a 40 px paragraph then 20 px words; `big-3rd`, `big-4th` and `big-5th`, a 40 px word third, fourth or fifth on the first line; `cjk`, `字` beside the words; `cjk-larger`, one of them at 30 px; `wide`, a word of 40 H's, wider than any span, after two words (#203).

### The band's height [M]

A band is the line's CSS line box less a tenth of that box's height at its top and at its bottom. The line box is the union of the text's own strut and each run's box, each half its leading above and below its em box: 1.2 × its size with Auto, the text's leading otherwise. On the slanted frame, a line's start gives its band's bottom:

| Line | Leading | Start | Band's bottom below the baseline | Line box | Tenth |
|---|---|---|---|---|---|
| 20 px | Auto | 27.2 at 57.08 | 4.52 | 17.08 + 6.92 | 2.4 |
| 40 px | Auto | 34.4 at 74.17 | 9.03 | 34.16 + 13.84 | 4.8 |
| 40 px | 30 | 30.52 at 65.17 | 6.39 | 25.16 + 9.92 | 3.508 |

The bottoms are Inkscape's, read from each line's start, which `results.tsv` rounds to a hundredth. ADR-0078's rule gives 4.52, 9.03 and 6.41 (9.92 − 3.508). At Auto, a larger size's box holds the strut, so the band is the larger size's box less a tenth of its leading, 0.1 × 48. At a set leading, a larger size's box reaches less far below the baseline than the strut does, 4.84 against 9.92, and the band reaches the strut's bottom. The mirrored slant (`x = 120 − (y − 40) / 3`, a line starting where the edge is at its band's top), probed during the investigation, gave the top: 14.68, 29.37 and 21.66 above the baseline, the same boxes less the same tenths. A line of one size is ADR-0078's band.

### Which words a band takes [M]

Inkscape starts each line with the strut's box. When a run's box is taller, it grows the line box to hold it and rebuilds the line from its first word, at the same line top, so the baseline moves down. It grows the box when it measures the run, before it knows whether the run fits. So a larger word that does not fit still sizes the line it could not join:

- `slant big-3rd`: the 40 px third word fits, and the band takes the words before it from 34.4, not 27.2.
- `slant big-5th` at Auto: four 20 px words fit a 20 px band from 27.2, but not the 40 px fifth. It grows the band, which then takes three words from 34.4 at 74.17. The fourth and the 40 px word start the next band, at 122.17, 48 lower.
- `U big-4th` at Auto: the 40 px word fits neither arm. The first band still takes the 40 px box, at 74.17, and the next band, holding it, is 48 lower.

### Skipped bands [M]

A band with no span wide enough for the next word is skipped, and the next try is one of that band's line boxes lower. It keeps the height the word gave it. `neck heading`: the 40 px heading is tried at 74.17 and at 122.17, 48 apart at Auto, and shows at 170.17 below the neck.

### Stacking [M]

Inkscape puts each line's top at the bottom of the line box before it. Kalamo follows Illustrator and steps each baseline by the line's leading (ADR-0080). The two agree while no taller line comes before. After a taller line they differ by ADR-0068's model difference: in `slant heading` at Auto, Inkscape's 20 px line is 30.91 below the heading and Kalamo's is 24 below it. They also differ on a line that a larger word makes taller. Inkscape keeps that line's top and moves its baseline down. Kalamo keeps its step, so the taller band reaches higher. In `neck big-3rd`, Inkscape's first line is at 146.17 at Auto and 125.17 at leading 30. Kalamo's is at 153.08 and 150.08. At 30 it is a band lower, because its taller band reaches into the neck. A skipped band differs as well under a set leading. Inkscape tries the next one line box lower and Kalamo one leading lower. In `neck heading` at leading 30, Inkscape shows the 40 px heading at 135.33, two 35.08 line boxes below 65.17, and Kalamo shows it at 125.17, two leadings below. At Auto the two are equal, since the line box is the leading.

### CJK [M]

With ADR-0080's run `line-height`, a CJK line at the text's size steps by the text's leading in every frame: 57.08, 81.08, 105.08 at Auto and 60.08, 90.08, 120.08 at leading 30 on the U. A 30 px CJK run on the first line puts its baseline at ADR-0022's first baseline for 30 px, 65.62 at Auto and 62.62 at leading 30, as Kalamo does. On a later line, Inkscape puts it 32.54 below the one before, where Illustrator's rule gives 36 or 30 (ADR-0080). The run's box under its shrunk `line-height` reaches 2.82 below the baseline, where a 30 px Source Sans 3 box reaches 10.38. So its line box is 32.54 tall at Auto, not 36, and its band is correspondingly shorter.

### Kalamo against Inkscape

A throwaway test laid out every case with core and compared the words on each line. 46 of the 48 cases give the same words. A baseline is the same as Inkscape's until a line taller than the text's size comes before it, is made taller by a larger word, or follows a band skipped under a set leading (see Stacking). The two that differ are model differences:

- `triangle heading` at Auto: every line after the heading is 6.91 higher in Kalamo, where the triangle is wider. The same words fill the first body line, and the second takes one word more, words 7 to 11 where Inkscape's takes 7 to 10.
- `triangle cjk-larger` at Auto: Inkscape's band for the 30 px CJK run is shorter at its bottom (see CJK), so it is wider and takes one word more.

## Round trip [M]

`pnpm roundtrip` passes with a new "Shaped Mixed Sizes" Artboard. It holds a U-frame text whose first paragraph is an 18 pt range in a 10 pt text, with `中文字` in a later band, at 8.11 % of the 25 % `mixed-size text` budget. It also holds a triangle at leading 14 whose first line holds a 20 pt range and whose third holds `汉字`, at 2.28 %. Inkscape saves the same lines. With #199's layout, whose bands were all the Node's own size, the triangle's third band took one word more than Inkscape's, and the line check failed. The first draft of the triangle's text had a first line only 0.06 pt narrower than Kalamo's unshaped width of "Big words start a", which Inkscape fit (ADR-0013's known difference). Its third word was changed.

## A rectangle frame (#203) [M]

For #203: whether rectangular Area Type can lay out through the shaped band filler. The rectangle's own fill differed from the band filler in three rules, and each is measured here in the `rect` frame. Decision: ADR-0083. `node docs/research/09-shaped-bands/probe.mjs rect` prints the frame's rows, and `probe.mjs threshold` prints the threshold rows. Kalamo's figures come from `layoutText` with the same text in pt: `node --experimental-transform-types docs/research/09-shaped-bands/kalamo.ts` prints each `rect` line's baseline and word count, then each threshold case's band-rule height, 90 % of the line's leading and Kalamo's baseline. A `threshold` row of `results.tsv` is the run's size, the leading, the frame height at which Inkscape first shows the line and its baseline below the frame's top.

### A unit wider than the frame

`rect wide`: Inkscape does not hide the 40-H word. It breaks it between characters: `HHH HHH`, then 14 H's on each of the next three lines, then `H HHH HHH`. The word's tspan box spans those lines, so its row in `results.tsv` gives the bottom of its last piece, 153.08, not a line of its own. The same content in one text node, with no tspans, breaks the same way. Every path frame breaks the word too. In `U wide` it starts in the right arm, after the left arm's two words, and breaks there. Only a narrower span that a later band widens is skipped: in `neck`, a 39-wide word skips the 30-wide neck. ADR-0022 says Inkscape overflows such a word and everything after it, and Kalamo does that in both frame kinds. The band filler, with one span per band, gives the same overflow as the rectangle's fill, since every band has the same span. #221 takes up the mid-word break.

### What sizes a line

Inkscape sizes a rectangle's line by every word it measures, including a larger word that does not fit, as in a path frame:

| Case | Inkscape's baselines | Kalamo's | Words per line, both |
|---|---|---|---|
| `big-4th`, Auto | 74.17, 122.17, 153.08, 177.08 | 57.08, 105.08, 129.08, 153.08 | 3, 3, 4, 2 |
| `big-4th`, 30 | 65.17, 100.25, 130.25, 160.25 | 60.08, 90.08, 120.08, 150.08 | 3, 3, 4, 2 |
| `big-5th`, Auto | 74.17, 122.17, 153.08, 177.08 | 57.08, 105.08, 129.08, 153.08 | 4, 3, 4, 2 |
| `big-5th`, 30 | 65.17, 100.25, 130.25, 160.25 | 60.08, 90.08, 120.08, 150.08 | 4, 3, 4, 2 |

Kalamo sizes each line by the characters it holds, as Illustrator's leading does (ADR-0068). The frame's width does not follow a line's height, so every line holds the same words in both. `heading`, `big-3rd`, `cjk` and `cjk-larger` also put the same words on each line in both. Their baselines differ after a taller line, as the Stacking section above says.

### The overflow threshold

`probe.mjs` bisects the frame height, to a thousandth, at which Inkscape first shows one line of `HHH` in a run of 20, 40 or 10 px in a 20 px text. The last column is Inkscape's baseline below the frame's top.

| Run, leading | Inkscape | Band rule | 90 % of the leading | Inkscape's baseline | Kalamo's |
|---|---|---|---|---|---|
| 20 px, Auto | 21.601 | 21.600 | 21.600 | 17.08 | 17.08 |
| 20 px, 30 | 26.999 | 27.000 | 27.000 | 20.08 | 20.08 |
| 40 px, Auto | 43.200 | 43.200 | 43.200 | 34.17 | 34.17 |
| 40 px, 30 | 31.575 | 31.575 | 27.000 | 25.17 | 25.17 |
| 10 px, Auto | 21.601 | 13.913 | 10.800 | 17.08 | 8.54 |
| 10 px, 30 | 29.288 | 27.000 | 27.000 | 20.08 | 17.54 |

The band is the line's box less a tenth of its height at its top and bottom, reaching at least the strut's bottom (ADR-0078's #200 amendment). Inkscape shows a rectangle's line while that band lies in the frame, the same rule as in a path frame. For a 40 px line at leading 30 the strut reaches 9.92 below the baseline and the line's own box only 4.84. The band ends 31.575 below the top, where 90 % of the leading gives 27. A 10 px line's baseline is lower in Inkscape than in Kalamo, because Inkscape's line box also holds the strut's ascent. That is ADR-0080's first-baseline model difference, so neither rule matches those rows. At Auto the band rule is the closer of the two.

### Round trip

`pnpm roundtrip` on this layout prints the same per-region figures as on `main` (32346ee), byte for byte. No fixture line has a box that the strut reaches below near its frame's bottom.

