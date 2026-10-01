---
status: accepted
date: 2026-10-01
---

# Tool definitions share their schemas, within a budget

An Agent reads every tool definition on every turn. Research 11 (#228) measured about 100k tokens of them on Haiku 4.5: `tools/list` was 323 KB of JSON, `kalamo_node_create` alone 196 KB. zod writes a schema out in full wherever it is used, so `node_create` held the Appearance, with its Fills, Strokes, gradients and Color Stops, 16 times: once in each of the eleven Node types, then again in each type of a Group's inline `children`. That second copy existed because the top-level Node types required `parentId` and the inline ones refused it, so they were different schemas. Tool descriptions also repeated what the schema fields and skill://kalamo/drawing-conventions already said (#229). This ADR amends ADR-0050's registration call.

## Decision

1. **Named definitions, written once per tool.** Core names the schemas that recur with zod's `id` metadata: `Node`, `Appearance`, `ContainerAppearance`, `Fill`, `Stroke`, `Gradient`, `ColorStop`, `CharacterRange`, `Color` and `Point`. `tool()` converts input schemas with `target: "draft-2020-12"`, which is MCP's default dialect, so zod writes each named schema once under `$defs`, and every use is a `$ref` that keeps its own `description` beside it. It also drops the `minimum` and `maximum` that zod gives every integer, the safe-integer bounds. The schema stays the one Kalamo parses with (ADR-0050).
2. **One Node schema.** `parentId` is optional on every Node type, so a Group's `children` are Nodes again (`$ref: #/$defs/Node`). Core keeps the old rules: a Node other than a Layer with no `parentId`, or a null one, is INVALID_PARENT, as before; an inline child that gives `parentId`, even null, is INVALID_INPUT at `nodes[i].children[k].parentId`, where the old schema refused the unknown key.
3. **Descriptions say a thing once.** A tool description names each form and what the schema cannot say. A field's meaning stays in the field's `description`, and the rules that hold across tools stay in the drawing conventions. `node_create`'s description went from 8.6 KB to 3.0 KB, and the shared write fields' `txId` and `ifRev` descriptions were shortened.
4. **A budget, checked in a test.** `server.test.ts` measures each tool as a client gives it to the model, `JSON.stringify({name, description, inputSchema})`, leaving out `outputSchema`. The total may be at most 112,000 bytes and each tool at most 28,000. A change that needs more raises the number in the same commit.

## Results

| | Before | After |
|---|---|---|
| `tools/list` | 323 KB | 146 KB |
| name, description and input schema, all tools | 285 KB | 108 KB |
| `kalamo_node_create` | 196 KB | 27 KB |
| `kalamo_node_update` | 21 KB | 15 KB |
| `kalamo_freehand_stroke` | 12 KB | 7 KB |
| `kalamo_path_op` | 12 KB | 10 KB |

`pnpm bench` on Claude Opus 5.5 (`claude-opus-5-5`), every task passing before and after. The first turn's input, the tool definitions and system prompt every turn starts with, went from 124.8k tokens to 46.9k in every task. Input tokens for each run, cache reads included, and cost:

| Task | Before | After |
|---|---|---|
| freehand | 530k, $0.25 | 218k, $0.54 (writing the new definitions to the cache); reruns 274k, $0.21 and 218k, $0.19 |
| grid | 945k, $0.38; reruns 1,094k, $0.63 and 810k, $0.35 | 297k, $0.45; reruns 343k, $0.27 and 533k, $0.55 |
| labels | 798k, $0.29 | 218k, $0.19 |
| place | 529k, $0.23 | 218k, $0.17 |
| transaction | 1,067k, $0.36 | 444k, $0.24 |

grid's cost depends on how the Agent lays out the grid, before and after alike. It costs about $0.30 when the Agent keeps `kalamo_node_duplicate`'s copies, and about $0.60 when it reads that the copies carry a transform and redraws 99 rects with their own x and y. That takes about 10k output tokens and 80–90 s. The three runs each way average $0.45 before and $0.42 after. The first after-run of freehand paid to write the 47k-token prefix to the cache; the baseline found it already cached by an aborted run of the same code.

## Considered Options

- **zod's `reused: "ref"`.** It moves every schema used twice into `$defs` under a generated name such as `__schema12`, down to a bare `{"type": "string"}`, and in draft 7 wraps each use in `allOf`. It cut `tools/list` to 178 KB and left names an Agent cannot read.
- **Moving field descriptions into the drawing conventions.** Fields would lose their meaning where an Agent fills them in, and an Agent that skips the resource would lose it entirely.
- **Leaving `outputSchema` out of `tools/list`.** Claude Code does not put it in the model's context, and other clients use it to check `structuredContent`, so it stays.
