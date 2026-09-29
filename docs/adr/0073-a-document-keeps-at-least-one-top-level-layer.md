---
status: accepted
date: 2026-09-30
---

# A Document keeps at least one top-level Layer

ADR-0072 left one file rule out of the checks every merge runs: "at least one top-level Layer". So `kalamo_node_delete` of the last Layer committed, and so did a staged delete of one Layer committed after a direct delete of the other, an undo of a Layer's creation after the other Layers went, and the browser `delete` Command, which calls the same core delete in the Document Durable Object. The Document left had no Nodes at all (every Node needs a Layer ancestor, ADR-0005), and its `kalamo_json` export failed `kalamo_doc_open` with `INVALID_DOCUMENT` "No top-level Layer." (ADR-0016). Nothing told the Agent until it re-opened the file (#192).

Illustrator has no document without a layer. The Layers panel does not delete the last one, and a script checks `document.layers.length > 1` before it calls `remove()`. Kalamo follows Illustrator's semantics (REQUIREMENTS §2), so a committed Document keeps the same invariant.

## The rule

A committed Document keeps at least one top-level Layer. `lostLastLayer(before, after)` in core is the rule: the top-level Layers of `before` that are gone from the root in `after`, when `after` has none. File validation checks the same predicate (`isTopLayer`) on the Nodes it reads.

The rule fires only on a write that removes the last one: at least one before, none after. A Document stored with no top-level Layer before this ADR stays writable, and `kalamo_node_create` of a top-level Layer repairs it. This is ADR-0072's "a rule an untouched Node already broke does not block every later write".

- **Direct and staged deletes.** `deleteNodes` refuses, with the new error `LAST_LAYER`, the delete that would remove the last top-level Layer. The message is "A Document keeps at least one top-level Layer.", the hint says to delete the Layer's contents instead or create another top-level Layer first, `path` is `nodeIds[i]` and `nodeIds` names the Layers. Without `partial` the whole call is refused and changes nothing: no `rev`, no undo entry, no `tx` broadcast; `nodeIds` names every top-level Layer the call deletes. With `partial` the targets are walked in order and the first that would remove the last Layer goes to `failed` by its index, naming that Layer; the targets before it are applied, and so are the Nodes after it, its own children included. The count is of top-level Layers after the whole delete, so a Layer and its children, in either order, give the same outcome. A staged delete sees the Transaction's view (ADR-0008), so it is refused the same way when it is staged. The browser shows the error's message as the rejection notice and keeps the Selection.
- **Commit.** A merge that leaves no top-level Layer, because deletes committed meanwhile met the Transaction's, is refused whole with `TREE_CONFLICT`, as ADR-0072 refuses other broken rules. `nodeIds` lists the top-level Layers the Transaction removes, the message says "no top-level Layer would remain", and the hint is ADR-0072's roll-back hint. The Transaction stays open.
- **Undo and redo.** Of the rows that would leave no top-level Layer, the last in row order is skipped and reported in `skipped`, and the merge runs again on the rest, until what is left applies. One Layer stays, and the rest of the step applies. Skipped ids reach `doc_changes` and the `tx` broadcast's `skippedIds` as ADR-0072's skips do.

`node_reparent` needs no case: moving the only top-level Layer means moving it into its own descendant, a cycle (ADR-0071), and crossed concurrent moves of two Layers are a `TREE_CONFLICT` cycle already (ADR-0072). `lostLastLayer` counts a Layer moved off the root as gone all the same.

## Considered Options

- **`INVALID_INPUT` for a direct delete.** Rejected: the call is well formed, it just asks for a Document Kalamo does not keep.
- **`TREE_CONFLICT` for a direct delete.** Rejected: it means an edit committed meanwhile, and its hint is to roll back, which fits no single direct call.
- **Refuse any write to a Document with no top-level Layer.** Rejected: a Document stored before this ADR could then never be repaired.
- **Skip every Layer-removing row on undo.** Rejected: one surviving Layer is enough, and skipping more drops more of the step than the rule needs.

## Consequences

- Replaces ADR-0072's sentence "The file-level rule 'at least one top-level Layer' is not one of them: `node_delete` may delete the last Layer." Amends ADR-0008 (a commit can also fail with `TREE_CONFLICT` for this rule) and ADR-0011 (undo and redo also skip for it).
- `LAST_LAYER` is added to core's error codes (REQUIREMENTS F-MCP-15).
- `kalamo_node_delete`'s and `kalamo_tx_commit`'s descriptions and `skill://kalamo/drawing-conventions` state the rule.
- With one linear undo stack the undo and redo skip cannot fire in the Durable Object (ADR-0011). It is tested at the core seam and, in the Durable Object, against a Layer deleted off the stack.
