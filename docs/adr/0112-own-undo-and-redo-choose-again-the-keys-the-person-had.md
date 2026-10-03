---
status: accepted
date: 2026-10-04
---

# The person's own Undo and Redo choose again the Anchors they had

ADR-0109 and #288 cleared the Direct Selection's keys on every path that the person's own Undo or Redo reshaped. The browser cannot tell how an Undo renumbers a path's Anchors, so it dropped the keys rather than leave them on the wrong points. After an Undo of a Reverse Path Direction press, the Attributes panel's direction buttons went disabled. To press again, the person had to choose the subpath again. An Undo of a drag or a convert also lost the Anchors that had been chosen (#273).

## Sources

- Adobe, Anshul Saini, Community Manager, in *Keep selection after undo (Ctrl+Z)*, Adobe Community, 2 December 2024 (community.adobe.com/t5/illustrator-discussions/keep-selection-after-undo-ctrl-z/m-p/15015449): "The Undo (Ctrl+Z) function is designed to roll back all actions—this includes silent actions, like changes in selection—bringing the artboard back to the last recorded state." A selection change is not an undo step of its own. Undo returns to the selection that went with the state it restores.
- Illustrator UserVoice, *Partial selection of points is lost (the whole object becomes selected) when Undo and/or Redo are used* (illustrator.uservoice.com, suggestion 49174934, reported 4 December 2024). The steps are: choose several points with the Direct Selection tool, move them with the Move dialog, then Undo. In 29.1 and 29.4 the whole object is then selected. Egor Chistyakov, an Adobe admin, filed this as a bug. On 11 April 2025 he wrote that older versions "HAVE this kept when Undo", while Redo still selected objects as a whole. On 14 July 2026 he reopened it as not fixed in 30.8 beta. On 5 December 2024 he wrote: "Many other editor do not change the selection when Undo is used, including Affinity Designer". That rule keeps the current selection rather than restoring the recorded one. The two differ only when the selection changed after the edit, and there Adobe's statement above decides.
- Illustrator UserVoice, *Ability to UNDO not only actual changes to objects but also selections* (suggestion 34934953): a selection change alone cannot be undone.
- ADR-0011: the Document has one undo stack, whoever committed each Transaction. An Undo is a new Transaction, and it does not say which `rev` it inverted.

Illustrator's intended behaviour, as Adobe states it, is that Undo and Redo bring back the selection that went with the state they restore, partial selections of points included. Recent versions select the whole object instead, and Adobe tracks that as a bug. Kalamo follows the intended behaviour.

## Decision

**The keys index geometry, so the browser keeps them by geometry.** In `apps/web/src/receive.ts`, `keysOn` keeps the keys of each path that a message changed. It keeps the keys before the change under the path's old geometry, and the keys after the change under its new geometry, as ADR-0109 defines geometry. On a given geometry, a key always names the same point. The latest keys on a geometry replace older ones. At most 200 geometries are kept, the undo stack's depth in Transactions. A change keeps two per path it reshapes, before and after, so fewer undo steps' keys stay. This is not a record of commands. `sent` (#288) is still the only record of what this tab sent.

**The person's own Undo or Redo chooses them again.** The answer to the person's own command can reshape a path in a way the browser cannot number, so that #288 would clear the path's keys. If the path's new geometry has keys in `keysOn`, those keys come back instead. Such an answer leaves `keysOn` as it was. Undo and Redo step between recorded states, as in Illustrator, so the keys before an edit and the keys after it both stay. An Undo of a press restores the Anchors and segments chosen before the press, and the panel shows the direction they had. A Redo restores those chosen after the press. A selection change between the two does not replace them. In Illustrator such a change is a silent action that Undo rolls back.

**Which edits.** The rule covers every edit that changes a path's geometry, not only Reverse Path Direction. Its effect is limited to what an Undo or Redo can bring back: the keys before and after a Reverse Path Direction press, a Direct Selection drag, an Anchors bar Convert, an Edit > Clear of Anchors or a segment, or a Remove Anchor Points, each pinned by a test in `attributes.test.ts`. In practice, only Undo and Redo return a path to a geometry it had before. Any other own command the browser cannot number that happens to rebuild such a geometry gets the same keys, which name the same points there.

**Edits that drop the keys when sent.** Edit > Clear on chosen Anchors or segments, Edit > Clear with the Curvature tool, Object > Path > Remove Anchor Points, and the Add and Delete Anchor Point tools' clicks go through `sendAnchorEdits` (`apps/web/src/anchorTools.ts`). It drops the keys when it sends, so the canvas and the Anchors bar never show a key on an Anchor the edit removes. It also keeps the keys it dropped on each path in `keysDropped`, under the `path_edit`'s command id, until the answer. The answer keeps them in `keysOn` under the path's geometry before the edit, as the keys before it, so the person's own Undo chooses them again (#313). A rejection, the Document sent on reconnect and a tool switch forget them. After a rejection the keys stay dropped, as ADR-0110 and #272 leave them.

**Only the person's own.** The answer counts as the person's own when its `commandId` is in `sent`. Another Actor's Undo, or the person's Undo from another tab, keeps ADR-0109's rule: keys on a path it changed are cleared, even when it returns the path to a geometry kept in `keysOn`. The Document sent on reconnect does not say whose change it brings, so it is read as another Actor's.

**What waited stays dropped.** #298 holds edits behind the person's own Undo or Redo. It drops a held edit, and what a drag still being made holds, on a path the answer reshapes. That rule is unchanged. The held edit's keys were worked out on the path before the Undo. The keys that come back are not a renumbering of those keys. They are the selection the person had on the geometry the Undo restores. A key clicked on that path between the Undo and its answer was numbered on the old geometry. The answer replaces it with the keys that come back, as Illustrator would have restored the selection before it took the click.

**What the rule leaves.** Keys live only on Nodes in the Selection, so they come back only on a path still selected. The Selection of Nodes is unchanged: Kalamo's Undo does not restore it. Switching tools drops the keys, and also forgets `keysOn`. A path the person's own edit deletes whole has no geometry after it, so an Undo that brings the path back brings no keys back on it.

ADR-0109's bullet on the Direct Selection and ADR-0110's paragraph "The answer numbers what waited" are amended to point here.

## Considered Options

- **Keep #288's default and clear the keys.** Rejected. Illustrator brings the selection back, and Adobe treats losing a partial selection as a bug. The person would choose the subpath again after every Undo of a press.
- **Name the inverted `rev` in an Undo's Transaction, and keep each own command's keys before and after it.** Rejected. The protocol would change, and the browser would need a second record, of answered commands. ADR-0011's undo stack is shared, so the `rev` may be another Actor's. Geometry already tells whether a set of keys fits the path.
- **Invert the answer's `Renumbering` (#298) or the press's turn.** Rejected. It only works for commands the browser can number, which a drag or a Delete is not. It also needs the same match of Undo to command that the previous option needs.
- **Bring keys back only after an Undo of Reverse Path Direction.** Rejected. Illustrator has one rule for every edit, and one rule here needs no command types.

## Consequences

- An Undo of a press made through the Attributes panel leaves the panel ready for the same subpaths, as before the press.
- When geometry repeats, keys come back too. If the person drags an Anchor away and an Undo puts it back, the Anchor is chosen again.
- `keysOn` lasts while one tool is in use and holds at most 200 geometries. The oldest geometry is dropped first.
