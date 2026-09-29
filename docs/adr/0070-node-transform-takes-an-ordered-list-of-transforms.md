---
status: accepted
date: 2026-09-30
---

# `node_transform` takes an ordered list of transforms, one Transaction for all of them

`kalamo_node_transform` gives every target the same transform. `each: true` only changes the pivot. So N Nodes that need N different transforms take N calls: N round trips, and N Transactions unless the Agent opens one with `tx_begin`. The poster test needed 16 calls to rotate 13 letters alternately by -7° and +6° (#21). Illustrator's Transform Each also applies one transform, so it gives no model for this.

## The rule

- **Two forms of one tool.** `kalamo_node_transform` takes either the single form, unchanged, or `{docId, transforms: [entry, ...], partial?, intent?, txId?, ifRev?}`. An entry has exactly the single form's per-transform fields (`nodeIds`, `translate`, `rotate`, `scale`, `skew`, `matrix`, `pivot`, `each`, `scaleStrokes`) with the same defaults and refinements. `transforms` holds 1 to 1000 entries. The tool advertises one flat strict object, as `kalamo_mask_make` does (ADR-0053), and Kalamo parses it into one form (ADR-0050). `transforms` together with a single-form field is `INVALID_INPUT` at that field, with a hint to put it inside an entry. A schema error inside an entry has its path, such as `transforms[2].matrix`. Schema errors refuse the whole call whatever `partial` says.
- **In order, pivots after earlier entries.** Entries apply in order, each to the Document the ones before it left. An entry's pivot comes from its targets' `geometricBounds` as the earlier entries left them. A Node listed in two entries gets both transforms composed in order, as two calls in sequence would give it. How one entry composes is unchanged (ADR-0007, ADR-0043).
- **One write.** The whole call is one Transaction, one WriteReceipt and one undo step (ADR-0011), with the summary `Transform N Nodes`. `updatedIds` lists each changed Node once, where it first appeared, with its final value, and `bounds` is the union of the final bounds. `NESTED_TARGET` warnings come from each entry as they do today. With `txId` the batch stages into the open Transaction like any write, and `ifRev` guards it as a whole.
- **`partial` per entry.** Without `partial`, a failing entry refuses the call and nothing changes. With `partial`, a failing entry is skipped whole: it is in `failed` with `index` = its position and `path` = `transforms[i].nodeIds[j]`, and the other entries apply. Inside an entry, one unknown id fails the entry, since applying the rest of its targets about a pivot computed without the missing one would be a transform nobody asked for. If every entry fails, the call fails with the first error, as for every other `partial` write. This is how `node_update` treats its patches.
- **Stateless.** The batch is one request. MCP stays stateless Streamable HTTP (ADR-0006).
- **The browser keeps the single form.** Its `transform` Command and the canvas gestures do not change.

## Considered Options

- **A new tool, `node_transform_each` or similar.** Rejected: it would repeat every field, description and refinement of `node_transform`, and an Agent would have to choose between two tools that do the same thing. Two forms of one tool already have a precedent in `mask_make`.
- **Pivots computed from the Document before the call.** Rejected: a Node listed in two entries would then turn about a centre it has already left, which matches neither Illustrator nor two calls in sequence.
- **`partial` per target id inside an entry.** Rejected above: the pivot of a shared-pivot entry depends on all of its targets.
- **`transform` on `node_create`.** Rejected: it covers only Nodes being created, and the poster case transforms Nodes that already exist.
