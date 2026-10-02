---
status: accepted
date: 2026-10-02
---

# Compound Path Make and Release are `path_op` ops

ADR-0018 made a Compound Path one `path` with several subpaths and a `fillRule`, and left Illustrator's Object > Compound Path > Make (Ctrl+8) and Release (Alt+Shift+Ctrl+8) unbuilt (F-BOOL-04, #266). This ADR builds them and records which of Illustrator's rules they follow.

## Sources

- Adobe, *Create compound paths in Adobe Illustrator* (helpx.adobe.com/illustrator/desktop/manage-objects/reshape-transform-objects/create-compound-paths.html): a compound path "acquires the fill, stroke, and style attributes of the backmost" object; Make gives "fills and holes based on the non-zero winding fill rule by default"; released paths keep the compound path's appearance and do not get back their own. Adobe's servers refuse automated reads, so these phrases were checked through search excerpts of that page, on 2026-10-02.
- Adobe Community, *Compound Path issue: can anyone explain how I got here* (community.adobe.com/t5/illustrator-discussions/compound-path-issue-can-anyone-explain-how-i-got-here/td-p/8976370): making a compound path "by default applies this rule and reverses the direction of the shape at the bottom".
- Adobe, *Group or ungroup objects*: grouped objects move into the layer of the frontmost object, behind it. The compound path page says compound paths act like groups.
- Research 06 §shortcuts (`docs/research/06-illustrator-drawing-tools.md`): Ctrl+8 and Alt+Shift+Ctrl+8.

## Decision

**Make and Release are the `path_op` ops `make_compound_path` and `release_compound_path`.** A new tool would add its whole definition to every turn (ADR-0088). The two ops add 621 bytes to `kalamo_path_op` (7,339 to 7,960), and the total stays under the 112,000-byte budget (110,002 to 110,623), so the budget does not rise.

- **Make's operands.** Each Node in `nodeIds` is a path or a Live Shape, which counts by its outline. A repeated id counts once. A text, an Image, a Group, a Layer, a Clipping Path and an Opacity Mask fail `INVALID_PATH` at `nodeIds[i]`. A Clipping Path and a mask paint nothing, and a Group holds at most one of either (ADR-0021, ADR-0103). The hint for a text says it needs Create Outlines, which is not built yet. A Group is refused, unlike the Shape Modes (ADR-0104): taking its paths out would leave its other children behind, with no clear place. The browser selects the paths inside a selected Group instead, as Illustrator's Make uses the paths in a selected Group. Fewer than two operands fail `INVALID_PATH` at `nodeIds`.
- **Make's geometry.** The result's `d` holds every operand's subpaths, operands back to front in paint order, each with its own `transform` and its ancestors' composed in, in the result parent's coordinates. The result has no `transform`. No boolean is run: every contour stays as it was.
- **Make's paint and fill rule.** The result takes the backmost operand's Appearance, mapped through its transform as the Shape Modes do it (ADR-0104). It also takes the backmost's opacity, blend mode, visibility, lock, tags, meta and `fillRule`. That rule is `nonzero` unless the backmost is an `evenodd` path. Under `nonzero` the backmost is reversed, as Illustrator reverses "the shape at the bottom", and every other operand keeps its direction. Live Shapes all wind the same way, so where they overlap the backmost there is a hole, and two concentric circles make a ring. An operand already drawn against the backmost fills where it overlaps, as in Illustrator, where Attributes > Reverse Path Direction fixes it; Kalamo's is `path_op reverse`. The backmost is reversed whole, so its own holes stay holes. Under `evenodd` directions do not matter, and none is changed.
- **Make's name and place.** The result has no name, so the Layers panel shows Illustrator's `<Compound Path>` for any path of two or more subpaths. It sits in the frontmost operand's parent at the frontmost operand's stacking place, as a Group would.
- **Release.** Each Node in `nodeIds` must be a path with two or more subpaths that is not a Clipping Path or an Opacity Mask, which would split into several. Anything else fails `INVALID_PATH` at `nodeIds[i]`, a one-subpath path included ("A path with one subpath is not a Compound Path"), and changes nothing. Release is not a silent no-op: an Agent that releases a plain path has the wrong Node. Each subpath becomes a new path in the Compound Path's place, the first subpath backmost, so Release undoes Make's stacking. Each keeps all of the Compound Path's attributes, `transform` and `fillRule` included, and has no name, as Illustrator names each one `<Path>`.
- **One write.** Each op is one Transaction with one WriteReceipt and one undo step. `createdIds` holds the result or results, and `deletedIds` the operands or the Compound Paths.
- **Browser.** Object > Compound Path, after Clipping Mask as in Illustrator, has Make (Ctrl+8) and Release (Alt+Shift+Ctrl+8). Make is enabled for two or more editable paths and Live Shapes in the Selection, and the paths in a selected Group count. A Group's are the leaves the Shape Modes take from it, core's `operandLeaves`: never a Clipping Path, an Opacity Mask or what a mask holds (ADR-0103). Like Object > Path, it leaves a selected text or Image out and as it was, where an Agent that names one is refused. Release is enabled when a selected path has two or more subpaths. What either creates becomes the Selection. A shortcut's digit is named by its physical key, so Alt+Shift+Ctrl+8 matches where Shift+8 types `*`.

## Considered Options

- **A `compound_path` tool.** Rejected: it costs definition bytes on every turn and repeats `path_op`'s `nodeIds` plumbing.
- **`evenodd` for every Make.** It needs no direction fix. But Illustrator makes nonzero Compound Paths, and an Agent that later adds a subpath should see it fill as in Illustrator.
- **The backmost's stacking place, as Minus Front does it.** Adobe documents the paint source, not the place. The place follows Illustrator's Group, which compound paths are documented to act like.
- **Reversing each operand that winds like the backmost**, so every overlap is a hole whatever was drawn. Rejected: it is not what Illustrator documents, and with three operands it inverts Illustrator's fill where one already winds against the backmost.
- **Release of a one-subpath path as a no-op.** Rejected: a typed error tells an Agent it named the wrong Node.

## Consequences

- An open path or a Line takes part as it is, and an open subpath fills as if closed. A Line as the backmost is reversed to no effect, so the operands in front of it make no holes in each other.
- The result goes into the frontmost's parent, so when that is a Clip Group, or a Group with opacity or an Opacity Mask, an operand from outside it is clipped or faded by it afterwards.
- Hidden and locked operands are joined like any other, as for the Shape Modes. The browser offers only what it can edit.
- Make and Release are not exact inverses. Release gives every part the backmost's paint, and the parts lose their old names and transforms. Illustrator behaves the same way.
