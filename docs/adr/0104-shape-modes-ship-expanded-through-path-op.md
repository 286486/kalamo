---
status: accepted
date: 2026-10-02
---

# Pathfinder Shape Modes ship expanded, through `path_op`

M1 lists "booleans (live + expand)", and F-BOOL-01 asks for Illustrator's four Shape Modes: Unite, Minus Front, Intersect and Exclude (#258). REQUIREMENTS §6.4 planned a `path_boolean` tool whose default is the live `compound_shape` node. This ADR amends that row and F-BOOL-01's default.

## Decision

**The four Shape Modes are `path_op` ops `unite`, `minus_front`, `intersect` and `exclude`, and they produce a plain path, as a plain click in Illustrator's Pathfinder panel does.** There is no `path_boolean` tool. Every tool definition counts against the budget an Agent pays on each turn (#229), and `path_op` already takes `nodeIds` and runs Skia. The live `compound_shape` form (Illustrator's Alt-click, F-BOOL-01/03) is a later ticket.

- **Operands.** Each Node in `nodeIds` is one operand, in document coordinates, with its `transform` and fill rule applied. A Live Shape counts by its outline, and an open subpath fills as if closed. A Group or Layer counts as one operand, the union of its path and Live Shape leaves that are not Clipping Paths. A text, an Image, a Clipping Path, and a Group or Layer without such a leaf fail `INVALID_PATH` at `nodeIds[i]`. The hint for a text says it needs Create Outlines, which is not built yet. A top-level Layer fails as well, because no parent is left to hold the result. A repeated id counts once. So does a Node inside another operand, which is already part of it, as when Illustrator selects a Group; the receipt warns `NESTED_TARGET` for it, as `transform` does. Fewer than two operands fail `INVALID_PATH`.
- **Combining.** Operands are taken back to front in paint order. The backmost is combined with each next one in turn by Skia PathOps (ADR-0034): `UNION`, `DIFFERENCE`, `INTERSECT` or `XOR`. So Minus Front subtracts every operand in front of the backmost. Intersect keeps the area all operands share. Exclude keeps the area covered an odd number of times. That is Illustrator's result for more than two objects.
- **Result.** One new `path`, with no `transform` and its `d` in its parent's coordinates. Several regions make one Compound Path (ADR-0018). `exclude` fills `evenodd`. `unite`, `minus_front` and `intersect` fill `nonzero`. Skia's output contours never cross, but each hole winds the same way as its outline. So the result goes once more through Skia's `SkOpBuilder` as a one-path union, whose FixWinding pass makes each hole wind against the contour that holds it.
- **Paint and place.** Unite, Intersect and Exclude take the topmost operand's paint. Minus Front takes the backmost operand's paint, as in Illustrator. The result takes that operand's name, visibility, lock, opacity, blend mode, tags and meta, and its stacking place in its parent. Its Appearance is that operand's topmost leaf's, mapped through the leaf's transform: gradients move with it, and Stroke widths and dashes scale by it, so the paint looks as before.
- **One write.** The operands are deleted with their subtrees. A Group operand goes whole, including any text or Image in it. The result is created. This happens in one Transaction with one WriteReceipt (`createdIds` the result, `deletedIds` the operands) and is one undo step.
- **Empty result.** When the result has no area, for example an Intersect of disjoint objects or a Minus Front whose front covers the back, the op fails `INVALID_PATH` and changes nothing (F-BOOL-06). A Skia failure is `BOOLEAN_FAILED`.

## Considered Options

- **A `path_boolean` tool, as §6.4 planned.** Rejected: it duplicates `path_op`'s `nodeIds` and geometry plumbing and costs tool-definition bytes on every turn.
- **The live `compound_shape` by default, as F-BOOL-01 planned.** Deferred: it needs a node type, Release and Expand, and a renderer path. The expanded form is the plain click in Illustrator CC and is useful on its own.
- **`evenodd` for every result.** It would avoid the winding pass. But Illustrator's Unite, Minus Front and Intersect give nonzero Compound Paths, and a path added to one later should fill the way it would in Illustrator.

## Consequences

- FixWinding can misjudge contours that touch at a single point. Such a hole may fill under nonzero. The code marks this limit with a `ponytail:` comment.
- Hidden and locked operands are combined like any other. Illustrator cannot select them, and the browser selects only what it can edit.
- The browser's Pathfinder panel can send these ops through the generic `path_op` command (`apps/web/src/menu.ts`) as a small follow-up.
