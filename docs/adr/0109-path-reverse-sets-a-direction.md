---
status: accepted
date: 2026-10-03
---

# The Attributes panel's path_reverse names the direction to reach

ADR-0108's Reverse Path Direction Off and On name a direction. The browser picked the subpaths that ran the other way, from its own copy of the Document, and sent `path_reverse` with only their indices. The Durable Object reversed each one with no condition. Browser commands are not checked against a `rev` (ADR-0010). So when the same subpath was reversed first, by an Agent's `path_edit reverse` or `path_op reverse` or by a press in another tab, the press flipped it back. The subpath then ran against the pressed button, and the press still took an undo step (#271).

## Sources

- Webdesign.org, *Illustrator Compound Paths*, cited in ADR-0108: "click the direction button that is not pressed". Off and On show the subpath's direction and set it. They are two values, not one toggle.
- Adobe Illustrator Scripting Guide, PathItem, cited in ADR-0108: `polarity` is a value of each path, `PolarityValues.POSITIVE` or `NEGATIVE`. Setting a path to the polarity it has leaves it as it is.
- ADR-0010 kept browser commands without a `rev`, and turned down a no-op answer for a delete of a gone Node, since "a command with no effect would need an answer that is neither a Transaction nor an error". A Direct Selection drag's `path_edit` ops are absolute, such as `move_anchor` to a point, so one applied after another Actor's edit still gives the value the person set. A reverse is relative: applied after the same reverse by someone else, it undoes it.

## Decision

**`path_reverse` sets a direction.** The command is `{type: "path_reverse", subpaths, clockwise}`. `clockwise` is true for On and false for Off, as ADR-0108 defines them on screen. The Durable Object reads each named subpath's direction from the committed Document at the moment it applies the command. It reverses only the subpaths that run the other way. A Live Shape is measured as the path that `path_edit` converts it to. Core's `directionEdits` makes those `path_edit reverse` inputs, one per path, and `runsClockwise` measures direction for both the panel and the Durable Object. A subpath with no area has no direction, so it is left out. A missing subpath is still refused with `INVALID_PATH`.

- **A mixed press** reverses only the subpaths that need it, in one Transaction, with one undo step. A path that needs no change is not in the Transaction.
- **A press with nothing left to change** writes no Transaction and leaves no undo step. The browser gets `rejected` with a new code, `NOTHING_TO_CHANGE`, as an empty undo stack gets `NOTHING_TO_UNDO`. Its message, "Those subpaths already run that way.", is the browser's notice. `rejected` is the only answer, other than a Transaction, that settles a command's preview, so it needs no new server message.
- **The browser** still sends only the subpaths that differ in its own copy, and sends nothing when none differ. The command now says which way they should run, so a subpath that was turned already is left alone.
- **The Direct Selection.** The browser renumbers the chosen Anchors at the press, as ADR-0108 does. When another Actor, or another tab, changes a path, its Transaction reaches the browser before the answer to the press. It clears that path's chosen Anchors and segments, as any edit to a path that this tab did not send does. So the race leaves none of them on the wrong Anchor. The Anchors on a path that the answer reversed name the same points they did before the press.

**What still holds.** ADR-0107's `path_op reverse` and `path_edit reverse` keep their meaning. Each reverses what it names, whatever its direction, as Illustrator's Object > Path > Reverse Path Direction does. ADR-0107 names `path_op reverse` as the fix for an operand drawn against the backmost: reverse the operand, a whole path, before Make. That statement still holds. ADR-0108's "No new Agent operation" also holds. `path_reverse` is a browser command, and no Agent tool's schema or description changes. An Agent reads a subpath's direction from `d` and reverses it with `path_edit`. If the Agent must not race another Actor, it passes `ifRev`. ADR-0108's Reverse Path Direction bullet is amended to point here.

## Considered Options

- **Keep the unconditional reverse and accept the race.** Once the race settled, the panel would read the stored direction and show the subpath against the pressed button. Rejected: a press of On would make a subpath Off, it would take an undo step, and fixing it would take a second press. Illustrator's buttons set a value, as `fill_rule` already does in Kalamo.
- **Check the press against the `rev` the browser read.** Rejected: ADR-0010 keeps browser commands without a `rev`. Any edit to any Node would then refuse the press, though only the named subpaths' directions matter.
- **Commit an empty Transaction for a press with nothing to change.** Rejected: it would add a `rev`, a history row and an undo step that changes nothing.
- **A new server message for a command that changed nothing.** Rejected: one command needs it, and `rejected` already settles the preview and shows the notice. ADR-0010 named this choice for the delete of a gone Node.
- **Make the browser's preview direction-aware.** Rejected for now: the race window lasts until the Durable Object answers, a few milliseconds on a local socket.

## Consequences

- Between another Actor's reverse and the answer to the press, the preview reverses the newer copy. The subpath may show the wrong way for that moment. The answer replaces the preview.
- `NOTHING_TO_CHANGE` is a browser-only code. No Agent tool returns it, as no tool returns `NOTHING_TO_UNDO`.
