---
status: accepted
date: 2026-10-04
---

# The person's own Undo and Redo select again what was selected in the state they restore

`receive` only pruned the Selection (ADR-0012): a Node the message deleted left it, and nothing joined it. An Undo of a Delete brought the Nodes back with their ids (ADR-0011), but unselected. An Undo of a move or a paint change left whatever was selected now, not what was selected in the state the Undo returned to. ADR-0112 brought Direct Selection keys back only on a path still selected, so an Undo of a Delete brought back neither the path nor its Anchors as chosen. Edit > Clear of every Anchor on a path sends a `delete` of the whole path, and that `delete` kept no keys at all (#313, #314).

## Sources

- Adobe, Anshul Saini, Community Manager, in *Keep selection after undo (Ctrl+Z)*, Adobe Community, 2 December 2024 (community.adobe.com/t5/illustrator-discussions/keep-selection-after-undo-ctrl-z/m-p/15015449): "The Undo (Ctrl+Z) function is designed to roll back all actions—this includes silent actions, like changes in selection—bringing the artboard back to the last recorded state." A selection change is not an undo step of its own, and Undo returns to the selection that went with the state it restores.
- Illustrator UserVoice, *Ability to UNDO not only actual changes to objects but also selections* (suggestion 34934953): a selection change alone cannot be undone.
- Illustrator UserVoice, *Partial selection of points is lost (the whole object becomes selected) when Undo and/or Redo are used* (suggestion 49174934): Adobe files a lost partial selection after Undo as a bug, so the selection that comes back includes the points chosen. ADR-0112 cites the thread in full.
- ADR-0011: the Document has one undo stack, whoever committed each Transaction. An Undo is a new Transaction, and it does not say which `rev` it inverted. Undo restores each Node's stored copy from before the Transaction (`revert` in `packages/core/src/tx.ts`), and a deleted Node comes back in the `tx`'s `created`, under its own id.

## Decision

**Keep the Selection under each Node state.** In `apps/web/src/receive.ts`, `selectionOn` keeps the Selection under the state of each Node a `tx` changed. It keeps the Selection before the `tx` under each Node's stored copy before it, and the Selection after under each stored copy after it. The key, `stateOf`, is the stored copy with its top-level keys sorted, so a copy Undo rebuilds key by key matches the one it restores. The latest Selection under a state replaces older ones. At most 200 states are kept, the undo stack's depth in Transactions, as in `keysOn`, oldest first out. A Node the `tx` creates has no stored copy before it, so the Selection before the `tx` is kept under its creation instead, `madeBy` its id (#316). Opening a Document, a connect, forgets them. A `document` message, sent on reconnect, keeps none, as it does not say what changed. Like `keysOn` (ADR-0112), this is not a record of commands.

**The person's own Undo or Redo selects them again.** The answer counts as the person's own Undo or Redo when `sent` (#288) keeps its `commandId` with the type `undo` or `redo`. `sent` now keeps each command id with its command's type, so it is still the only record of what this tab sent. When such an answer brings a Node back to a kept state, the Selection becomes the Selections kept under every state it brings back, merged. Nodes it names that are gone, hidden, locked or outside the current Isolation are not selected (ADR-0010, ADR-0057). Every answer to the person's own Undo or Redo leaves `selectionOn` as it was, whether it brings back a kept state or not, as Undo and Redo step between recorded states. Otherwise a Redo of a Delete, which brings back no state, would keep the Selection at its answer under the states it deletes, and the next Undo would select that instead. An Undo also brings back the Selection kept under the creation of each Node it deletes, as an Undo deletes only what a `tx` created. So an Undo of drawn art selects again what was selected before it was drawn, or nothing if nothing was. A Redo does not, as its deletes redo a Delete, after which the Selection is only pruned. If it brings back no kept state, the Selection is only pruned, as before.

So:

- Select two paths, Delete, then Undo: both come back selected. A Redo deletes them, and they leave the Selection.
- Select A, move it, select B, then Undo: A is selected, and B is not. In Illustrator, choosing B was a silent action that the Undo rolls back.
- A Redo of a move or a paint change selects what was selected after it.
- Select A, draw a path, then Undo: A is selected, with its keys (below). A Redo selects the path again, as the draw did. Select A, draw B, Delete B, then Undo twice: B, then A, is selected.

The rule applies only to Undo and Redo, not to any of the person's own commands. Another command that rebuilds a kept state, such as a nudge back, or showing a Node again in the Layers panel, would otherwise replace a Selection made since then.

**Keys come back on the paths selected again.** ADR-0112's keys come back on a path in the Selection after the answer, which now includes a path the Undo selects again. That covers a path the Undo creates again: the person's own command brought it back, so its kept keys come back too. Keys on a Node that the restored Selection leaves out are dropped, as keys live only on selected Nodes.

A path the answer takes out of the Selection but leaves alone, as drawn art takes out what was selected before, keeps its keys under its geometry in `keysOn`, as an edited path does (#316). When the person's own Undo or Redo selects it again, they come back if its geometry has not changed. So an Undo of art drawn while Anchors of A were chosen, such as a paste with the Direct Selection tool, chooses them again. A tool switch forgets them, as ADR-0112 says, so after the Pen or the Rectangle tool the Undo selects A without its Anchors.

**A path deleted whole keeps its keys.** `chosenAgain` keeps the keys of a path a `tx` deletes under its geometry before the delete, and brings them back when the person's own Undo creates the path again. `sendAnchorEdits` (`apps/web/src/anchorTools.ts`) drops the keys when it sends. For the paths its `delete` removes whole, such as an Edit > Clear of every Anchor on a path, it keeps the keys it dropped in `keysDropped` under the `delete`'s command id, as it does for each `path_edit` (#313). An Undo of such a Clear brings the path back selected, with its Anchors chosen again. Another Actor's change to the path before the answer drops those keys, as ADR-0112 drops them.

**Only the person's own.** Another Actor's Undo, or the person's Undo from another tab, leaves the Selection as `receive` treats it: pruned, never added to. Their commands are not in `sent`.

**Presence.** The restored Selection is a Selection change like any other, so Presence sends it (ADR-0090).

The rule shares ADR-0112's accepted limit. The Selection kept before a `tx` is the one at its answer, not at its send. A selection changed inside one round trip counts as before the edit.

ADR-0012 and ADR-0112's "What the rule leaves" are amended to point here.

## Considered Options

- **Keep the Selection per Node, and only add the Nodes whose restored state was selected.** Rejected. Select A, move it, select B, then Undo would leave A and B selected. Illustrator brings back the selection of the state it restores, which had only A.
- **Key the Selection by geometry, as `keysOn` keys the Anchors.** Rejected. A move or a paint change does not change a path's geometry, so an Undo of either would not match the state it restores.
- **Restore the Selection after any of the person's own commands that rebuilds a kept state.** Rejected. A nudge back, or showing a Node again, would replace a Selection made since. Only Undo and Redo step between recorded states.
- **Name the inverted `rev` in an Undo's Transaction, and keep each own command's Selection before and after it.** Rejected for ADR-0112's reasons: it changes the protocol and needs a second record, of answered commands.
- **Add a set of the person's Undo and Redo command ids beside `sent`.** Rejected. It would be a second record of sent commands. Keeping the command type in `sent` tells them apart with the one record.

## Consequences

- An Undo of a Delete, a move or a paint change leaves the Selection the person had in the state it restores. Edits made right after the Undo apply to that Selection.
- When a Node's state repeats, its Selection comes back too. If an Undo returns a path to a state it had twice, the latest Selection kept under that state comes back.
- An Undo that merges another Actor's later change into a Node may build a state the browser never saw. That Node then brings back no Selection.
- `selectionOn` holds at most 200 Node states. A change to more than 100 Nodes at once fills it with the states of the Nodes it lists last.
