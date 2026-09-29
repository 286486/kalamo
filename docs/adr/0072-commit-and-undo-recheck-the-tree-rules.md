---
status: accepted
date: 2026-09-30
---

# Commit, undo and redo re-check the tree rules, one Clipping Path per container and unique sibling keys

Committing a staged Transaction (ADR-0008) and undo or redo (ADR-0011) merge per top-level key onto the Document as committed now. They checked only that an edited Node, or a created Node's parent, still existed. Two edits that are each valid could then together commit a Document that breaks Kalamo's own rules (#189):

- A cycle: a staged move of Group G1 into G2, committed after a direct move of G2 into G1. An undone move gives the same.
- A Layer in a Group, or a non-Layer at the root, from a row whose `parentId` no longer fits.
- Two Clipping Paths in one Layer or Group: two Transactions each make a different child of one Layer its Clipping Path (ADR-0053), or an undo moves a Clipping Path back into a container that got another meanwhile.
- Two siblings with one fractional-index key: two staged Transactions each create a Node on top of one parent, and both take `generateKeyBetween(last, null)`. An undo that brings back a deleted Node can find its key taken by a Node created since.

Such a Document passed every later write, but `doc_outline` and the canvas looped or ordered siblings arbitrarily, its `.kalamo.json` export failed to re-open (ADR-0016 refuses exactly these states), and a later move or create between two equal keys threw a plain `Error` from `fractional-indexing` instead of a `KalamoError`.

## The rule

A committed Document always passes the checks file validation runs on each Node. `checkTree` in core is those checks, and `parseDocument` and every merge call it, so the two cannot drift. It checks, in order: the parent exists and may hold the Node (`assertParent`: tree rules and cycles, ADR-0005), the `index` is a valid key that no earlier sibling holds, and a Clipping Path is the one visible clipping child of a Layer or Group. The file-level rule "at least one top-level Layer" is not one of them here; ADR-0073 adds it to every write.

`commitTransaction` and `applyRows` (undo and redo) merge the rows into a copy of the Document, then:

1. **Rekey duplicate keys.** Each created or updated Node, in row order, whose `index` a sibling now holds gets `generateKeyBetween(index, next key above)`. It lands in its intended slot, just above the Node that took it, and no other key changes. Two concurrent creates on top of one parent both end above the previous top sibling, the later-committed one on top. This comes from normal concurrent work, so it is repaired, never refused. It is deterministic: the same Document and rows give the same keys.
2. **Check the Nodes the merge touched.** `checkTree` runs over the untouched Nodes first and then the created and updated ones, so of two Clipping Paths the touched one is named. Only touched Nodes are reported: a rule an untouched Node already broke, in a Document committed before this ADR, does not block every later write.
3. **On conflict:**
   - **Commit** (`kalamo_tx_commit`) is refused as a whole with the new error `TREE_CONFLICT` and changes nothing. `nodeIds` lists the touched Nodes that break a rule, the message says which rule each breaks, and the hint says to roll back with `kalamo_tx_rollback` and redo the work in a new Transaction. The Transaction stays open, as with `NODE_GONE`.
   - **Undo and redo** skip the offending rows, whole, and report them in `skipped`, as they skip delete-beats-edit rows. Skipping a row can make another unplaceable (a create under a skipped create), so the check repeats on what is left until it applies. Skipped ids reach `doc_changes` in the summary (`skipped, deleted or moved since: …`) and the `tx` broadcast as `skippedIds`.

**A merge that closes a cycle** is caught before anything else runs. The committed Document has no cycle, so one runs through a Node the rows moved or created. Such Nodes are the conflict: nothing lies "beneath" a deleted Node inside a cycle, so deletes in the same rows wait. Without this, a delete row whose Node sits in the cycle walked its subtree forever. The commit is refused, and undo or redo skips those rows and runs again on the rest, where the deletes take their descendants as committed now.

**A staged Transaction's view** (its overlay, ADR-0008) can close a cycle too, once moves committed meanwhile meet its own. Every read or write in that Transaction then fails with `TREE_CONFLICT`, naming those Nodes, with the same hint: the commit would be refused anyway, and nothing could walk that view. `kalamo_tx_commit` and `kalamo_tx_rollback` do not read the view, so the Transaction can still be rolled back.

`NODE_GONE` also covers a Node the Transaction moved into a parent deleted meanwhile, as it covers one created there (ADR-0008). Before, that commit stored a `parentId` naming no Node.

## Considered Options

- **Skip the conflicting row on commit**, as undo does. Rejected: a Transaction is atomic (ADR-0008). Committing some of its rows would commit half of the Agent's work under one `rev`, and the Agent would have to diff the receipt to find what is missing. A refusal names the Nodes and leaves the Transaction open, so the Agent can read the Document and redo the work.
- **Refuse on undo and redo.** Rejected: the stack would stop at that entry for everyone (ADR-0011 pops strictly in order). Skipping keeps the rest of the undo, as delete beats edit does.
- **Refuse a duplicate key.** Rejected: two Agents each adding a Node on top of one Layer is ordinary work. Refusing it would make the later Agent redo a correct write because of a key it never chose.
- **Rekey every sibling evenly.** Rejected: it would change keys of Nodes the Transaction never touched, and every such Node would appear in the receipt and the delta.
- **Check only the rows, before the merge.** Rejected: the conflicts come from edits committed meanwhile, so only the merged Document shows them.

## Consequences

- Amends ADR-0008: a commit, or a read or write in a Transaction whose view became cyclic, can also fail with `TREE_CONFLICT`. Amends ADR-0011: undo and redo also skip rows that would break a tree rule or add a second Clipping Path.
- Every commit, undo and redo checks the whole Document: linear in its Nodes times their depth, next to the full load each write already does.
- With one linear undo stack an undo always applies to the state its Transaction left, so its skip rule still cannot fire in the Durable Object (ADR-0011, Consequences). It is tested at the core seam and, in the Durable Object, against a Node row edited off the stack.
- A committed Transaction's receipt can carry a created Node's `index` that differs from what its overlay showed; the receipt and the `tx` broadcast carry the stored copy.
