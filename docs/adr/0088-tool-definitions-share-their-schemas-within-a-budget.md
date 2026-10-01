---
status: accepted
date: 2026-10-01
---

# Tool definitions share their schemas, within a budget

An Agent reads every tool definition on every turn. Research 11 (#228) measured about 100k tokens of them on Haiku 4.5: `tools/list` was 323 KB of JSON, `kalamo_node_create` alone 196 KB. zod writes a schema out in full wherever it is used, so `node_create` held the Appearance, with its Fills, Strokes, gradients and Color Stops, 16 times: once in each of the eleven Node types, then again in each type of a Group's inline `children`. That second copy existed because the top-level Node types required `parentId` and the inline ones refused it, so they were different schemas. Tool descriptions also repeated what the schema fields and skill://kalamo/drawing-conventions already said (#229). This ADR amends ADR-0050's registration call.

## Decision

1. **Named definitions, written once per tool.** Core names the schemas that recur with zod's `id` metadata: `Node`, `Appearance`, `ContainerAppearance`, `Fill`, `Stroke`, `Gradient`, `ColorStop`, `CharacterRange`, `Color`, `Point`, `ParentId` and `ClientKey`. `tool()` converts input schemas with `target: "draft-2020-12"`, which is MCP's default dialect, so zod writes each named schema once under the tool's own `$defs`, and every use is a `$ref` that keeps its own `description` beside it. It also drops the `minimum` and `maximum` that zod gives every integer, the safe-integer bounds. The schema stays the one Kalamo parses with (ADR-0050), so no validation moves to the client.
2. **One Node schema.** `parentId` is optional on every Node type, so a Group's `children` are Nodes again (`$ref: #/$defs/Node`). Core keeps the tree rules, with one change of code. A leaf or Group whose `parentId` is left out or null was INVALID_INPUT from the schema; it is now INVALID_PARENT from `assertParent`, at the same `nodes[i].parentId`, with the message and hint `kalamo_node_reparent` already gives a Node moved to the root. Keeping INVALID_INPUT would take a second check for the rule `assertParent` already holds. An inline child that gives `parentId`, even null, stays INVALID_INPUT at `nodes[i].children[k].parentId`, now raised by core instead of the schema's unknown key. `document.test.ts` covers both.
3. **Descriptions say a thing once.** A tool description names each form and what the schema cannot say. A field's meaning stays in the field's `description`, and the rules that hold across tools stay in skill://kalamo/drawing-conventions, which each of these descriptions points to. `node_create`'s description went from 8.6 KB to 2.8 KB, `node_update`'s from 2.6 KB to 1.7 KB, `path_op`'s from 5.5 KB to 2.5 KB and `freehand_stroke`'s from 0.9 KB to 0.6 KB. What only a description said moved to the conventions: a Path operations section (which ops convert a Live Shape and warn CONVERTED_TO_PATH, what each leaves alone, when each fails, the receipt's ids), how `kind` converts a text, and how `src` and `file` Relink and Embed. The pitfalls an Agent meets while writing the patch stay in `node_update`: writing `content` clears `ranges`, and `file: null` without `src` fails INVALID_IMAGE. A linked Image's `file` field states its 2048-character limit.
4. **A budget, checked in a test.** `server.test.ts` measures each tool as a client gives it to the model, the UTF-8 bytes of `JSON.stringify({name, description, inputSchema})`, leaving out `outputSchema`. The total may be at most 112,000 bytes and each tool at most 28,000; the total is 100,796 and `node_create` 24,416, so each has about 10% to spare. A change that needs more raises the number in the same commit.

## Results

| | Before | After |
|---|---|---|
| `tools/list` | 323 KB | 139 KB |
| name, description and input schema, all tools | 285 KB | 101 KB |
| `kalamo_node_create` | 196 KB | 24 KB |
| `kalamo_node_update` | 21 KB | 14 KB |
| `kalamo_path_op` | 12 KB | 7 KB |
| `kalamo_freehand_stroke` | 12 KB | 7 KB |

`pnpm bench` ran before, on main at bbbb81b in a detached worktree, and after, at 98fd225, alternating, twice with Claude Haiku 4.5 (`ANTHROPIC_MODEL=claude-haiku-4-5-20251001 pnpm bench`) and once with Claude Opus 5.5 (the default). Every task passed in every run. `pnpm bench` prints, for each task, the first turn's input (`prefix`: the tool definitions and system prompt every turn starts with), the input over all turns with cache reads (`in`), and what of it was written to the cache (`cacheWrite`). The prefix went from 100.7k to 39.2k tokens on Haiku and from 124.8k to 45.8k on Opus, in every task. Input and cost per run:

| Task | Haiku before | Haiku after | Opus before | Opus after |
|---|---|---|---|---|
| freehand | 450k, $0.35; 444k, $0.15 | 190k, $0.16; 190k, $0.09 | 663k, $0.28 | 216k, $0.54 |
| grid | 663k, $0.16; 545k, $0.15 | 353k, $0.15; 255k, $0.17 | 943k, $0.37 | 395k, $0.27 |
| labels | 538k, $0.10; 535k, $0.09 | 230k, $0.06; 231k, $0.07 | 799k, $0.31 | 327k, $0.21 |
| place | 427k, $0.08; 537k, $0.09 | 232k, $0.06; 186k, $0.06 | 530k, $0.23 | 219k, $0.18 |
| transaction | 865k, $0.13; 862k, $0.13 | 378k, $0.09; 374k, $0.08 | 1,067k, $0.36 | 439k, $0.24 |

Input fell by half or more in every run. Cost fell in every task but two, and both exceptions come from things that vary between runs, not from the definitions:

- **The cache.** The first run of each variant pays to write the new prefix to the cache: Haiku's first freehand before wrote 121k tokens and cost $0.35, against $0.15 for the second, and Opus's freehand after wrote 58k and cost $0.54, where the other Opus runs wrote 13–20k. A run that starts within the cache's lifetime of one with the same definitions does not pay it. Two more Opus freehand runs at 4f8d7c8, whose definitions are those of 98fd225, started warm, one after the other, and did the same work as the cold one: prefix 45.8k, input 216k, 5 turns, 4 tool calls. They wrote 14.1k to the cache instead of 58k, read 202k from it, wrote 2.3k output tokens, and cost $0.20 each, against $0.54 cold and $0.28 for the one run before. The cold run's output tokens were not recorded.
- **The Agent's plan.** grid on Haiku cost about the same before and after ($0.16 and $0.15, then $0.15 and $0.17) and took longer after (99 s and 88 s, against 59 s and 81 s), because the Agent wrote more output after (12.6k and 16.2k tokens, against 10.1k and 10.8k): how it lays out the 100 rects varies from run to run. Earlier Opus runs for this ADR cost about $0.30 when the Agent kept `kalamo_node_duplicate`'s copies and about $0.60 when it read that the copies carry a transform and redrew them.

So no task got worse once the cache write is set aside: input fell in every run, and cost fell in every task but Haiku grid, which held even ($0.15 and $0.17 after, against $0.16 and $0.15) for the plan variance above. The Opus freehand comparison rests on one run before and two warm runs after, and the other tasks on two runs on Haiku and one on Opus, which show a direction, not a rate.

## Considered Options

- **zod's `reused: "ref"`.** It moves every schema used twice into `$defs` under a generated name such as `__schema12`, down to a bare `{"type": "string"}`, and in draft 7 wraps each use in `allOf`. It cut `tools/list` to 178 KB and left names an Agent cannot read.
- **Moving field descriptions into the drawing conventions.** Fields would lose their meaning where an Agent fills them in, and an Agent that skips the resource would lose it entirely.
- **Leaving `outputSchema` out of `tools/list`.** Claude Code does not put it in the model's context, and other clients use it to check `structuredContent`, so it stays.
