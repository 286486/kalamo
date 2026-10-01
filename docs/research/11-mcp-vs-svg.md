# Research 11: drawing through Kalamo MCP vs writing SVG

Measured on 2026-10-01 for #228. Haiku 4.5 (`claude-haiku-4-5-20251001`) ran four tasks twice through `claude -p`: once with only the Kalamo MCP tools (and its resources, as `pnpm bench` does), once with only `Read`, `Write` and `Edit`, writing an SVG file. Each task ran once per arm, so the numbers show a direction, not a rate. `11-mcp-vs-svg/run.mjs` reruns it against a local Kalamo; `11-mcp-vs-svg/results.tsv` holds the numbers below. Since #231, `pnpm bench` runs a write-SVG arm beside each task that has one, so new comparisons go there; see "In `pnpm bench`" below.

## Tasks

- **glass**: a 1600 × 1000 poster of translucent glass blobs, a ring, a star and droplets, "as polished as you can".
- **chart**: a bar chart of four quarters with a title, a 0–30 y axis with gridlines and tick labels every 5, value labels above and quarter labels below each bar, the highest bar in another colour, nothing overlapping.
- **edit**: a person's poster (title, subtitle, three circles, a button, a curve) given as a Document or as `poster.svg`; change the title and make every circle `#3565E8`, leaving the rest as it is.
- **text**: a 110-word paragraph in a 320 pt wide box at (140, 120), 16 pt Source Sans 3, justified, with a 1 pt rectangle exactly around the text.

## Results

| Task | MCP | SVG | Outcome |
|---|---|---|---|
| glass | 80 s, $0.46, 14 calls | 43 s, $0.07, 1 call | Both mediocre: MCP crisp but flat, SVG soft and blurry |
| chart | 48 s, $0.32, 6 calls | 36 s, $0.06, 1 call | MCP wrong: tick labels and gridlines squeezed into the bottom third, bars above the 30 line; it rendered once and did not notice. SVG correct |
| edit | 17 s, $0.27, 5 calls | 9 s, $0.03, 5 calls | Both correct, nothing else changed |
| text | 82 s, $0.47, 17 calls | 93 s, $0.11, 1 call | MCP: Kalamo's justified Area Type is good, but the rectangle is two lines short; eight renders did not fix it. SVG: rectangle right, but lines broken by hand and stretched with `textLength`, so spacing varies line to line; `font-family="Source Sans 3"` unquoted is invalid CSS, so browsers fall back to their default font |

## Tool definitions dominate the MCP runs

Every MCP turn starts with about 100k tokens of tool definitions (the first turn's `cache_creation_input_tokens` is 100.7k–100.9k in all four runs). `tools/list` returns 323 KB of JSON; `kalamo_node_create` alone is 196 KB, then `kalamo_node_update` 21 KB, `kalamo_freehand_stroke` 12 KB and `kalamo_path_op` 12 KB. So the MCP runs read 20–70 times the input tokens of the SVG runs (537k–2,042k against 23k–31k) and cost 4–9 times as much, with caching.

## What it shows

- An agent that can write files draws one-off pictures as well by writing SVG, faster and cheaper. "An agent can draw" does not set Kalamo apart.
- Kalamo's text layout helps (real line breaks and justification), but the agent cannot read the text's laid-out height back, so it still drew the box wrong.
- The edit task was too simple to separate the arms: the SVG agent kept the person's work too. A harder edit (an Inkscape-saved file, finding what a person changed, a chart with data) is needed.

## In `pnpm bench`

#231 brought the write-SVG arm into `pnpm bench` (`--model` picks the model) and added tasks where Kalamo should win: `edits` (three sessions in a row on a 200-seat plan), `person` (recolour, but keep what another Actor changed since rev 2), `inkscape` (move a Group in an A5 page saved by Inkscape 1.2.2 in millimetres) and `fit` (research 11's text task). `grid`, `labels` and `place` gained SVG arms. The SVG arm is judged by opening its file with `kalamo_doc_open` and asserting what the MCP arm's Document must hold, so where Kalamo's Open misreads valid SVG, the bench cannot judge that arm.

Haiku 4.5 on 2026-10-01, after the tool definitions shrank (#229). A full run, then reruns of `edits`, `fit` and `place` after their prompts or checks were fixed:

| Task | MCP | SVG |
|---|---|---|
| edits | pass, 14 calls, 115 s, $0.24, 785k in. Rerun: FAIL, the widening sent 89 of the 90 seats and left `I20`; 13 calls, 80 s, $0.20, 640k in | pass, 18 calls, 134 s, $0.25, 393k in. Rerun: pass, 22 calls, 228 s, $0.39, 670k in |
| fit | pass, 5 calls, 33 s, $0.08, 280k in. Rerun: the rect framed `lineBounds`, from the first line's ascender 2.3 pt above the text box; the check first wanted the box's top and failed it, then was fixed and passes it; 5 calls, 38 s, $0.08 | FAIL: the paragraph as HTML in a `<foreignObject>`, not SVG text; 93 s, $0.06. Rerun, the prompt asking for SVG `<text>`: lines broken by hand as `<tspan x dy>` and stretched with `textLength`, which Kalamo's Open joins into one line (#238), so unjudged; 55 s, $0.07 |
| freehand | FAIL: the fitted wave overshoots to y 124 (want 150 to 250); 65 s, $0.10 | — |
| grid | FAIL: no `Grid` Layer; 99 s, $0.14 | pass, 1 call, 21 s, $0.04 |
| inkscape | pass, 8 calls, 28 s, $0.08, 331k in | pass, 3 calls, 74 s, $0.08, 54k in |
| labels | pass, 5 calls, 43 s, $0.09 | pass, 1 call, 28 s, $0.04 |
| person | pass, 6 calls, 29 s, $0.07, 282k in | pass, 6 calls, 17 s, $0.04, 32k in |
| place | pass, 5 calls, 15 s, $0.05. Rerun: pass, 16 s, $0.06 | FAIL: the logo pasted as a nested `<svg>`, which Kalamo's Open drops (#237); 11 s, $0.03. Rerun, the prompt asking for its elements: pass, 2 calls, 20 s, $0.03 |
| transaction | pass, 7 calls, 45 s, $0.09 | — |

- With definitions at 39k tokens, not 100k, an MCP task costs about what writing SVG does, $0.05–0.24 against $0.03–0.39, but still reads 3–10 times the input tokens.
- Edits in a row on a large file are where the arms meet: the SVG agent rereads the 200-seat file each session (393k–670k in, 18–22 calls) and costs as much as the MCP agent, or more.
- Both arms handled the Inkscape file and found the other Actor's changes; the SVG agent converted millimetres correctly and diffed `mine.svg` against `drawing.svg`.
- Text is where writing SVG is weakest: Haiku reached for HTML, then for hand-broken lines stretched with `textLength`, while the MCP agent read `lineBounds` and framed the text in one call.
- The MCP arm's misses are the model's: a named Layer left out in `grid`, a freehand wave's extent in `freehand`, one id dropped from 90 in `edits`. One run per arm shows a direction, not a rate.
