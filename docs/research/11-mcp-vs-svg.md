# Research 11: drawing through Kalamo MCP vs writing SVG

Measured on 2026-10-01 for #228. Haiku 4.5 (`claude-haiku-4-5-20251001`) ran four tasks twice through `claude -p`: once with only the Kalamo MCP tools (and its resources, as `pnpm bench` does), once with only `Read`, `Write` and `Edit`, writing an SVG file. Each task ran once per arm, so the numbers show a direction, not a rate. `11-mcp-vs-svg/run.mjs` reruns it against a local Kalamo; `11-mcp-vs-svg/results.tsv` holds the numbers below.

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
