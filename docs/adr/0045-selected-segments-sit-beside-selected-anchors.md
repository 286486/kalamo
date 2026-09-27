---
status: accepted
date: 2026-09-27
---

# Selected segments sit beside selected Anchors

Direct Selection could drag a segment but not select one, so clicking a segment selected the path and Delete removed the whole path. Illustrator selects the segment alone: Delete removes it and keeps its end Anchors, opening the path there (#114).

## Decision

- **State.** The store holds `segments: string[]` next to `anchors: string[]`. Both are UI state, never sent as a Document property, like the Selection. A segment key has the Anchor key's form (`nodeId subpath index`) and names the Anchor the segment starts at: segment k runs from Anchor k to the next, and a closed subpath's last segment is the closing one. One key format keeps one parser, and a segment's key doubles as the key of the Anchor that shows its first Handle.
- **Two lists, not one tagged list.** A key alone cannot say whether it names an Anchor or a segment. Keeping them apart leaves every existing reader of `anchors` (Join, Average, Remove Anchor Points, the Curvature tool, marquee) unchanged. Every place that resets `anchors` resets `segments` too: switching tools, a click that is not a Shift+click, a marquee without Shift, a Selection that drops the Node, reconnecting and each Anchor edit sent.
- **Remote edits.** Selected segment keys follow the Anchor-key rule in `receive`: after someone else's change to a Node, its keys go; after our own command or a reconnect, a key stays while `segmentInRange` says the Node still has that segment. Edit > Clear ignores a key out of range, so it is never sent as a no-op `set_d` that would convert a Live Shape (ADR-0032).
- **Delete.** One pure `deleteParts(subpaths, anchors, segments)` removes both kinds in one walk: a cut Anchor takes its two segments, a cut segment only itself. It commits one `path_edit` `set_d` per path, so one undo restores every segment removed from one path, and clears both lists, so the path stays selected and a second Delete removes it.

## Considered Options

- **A tagged key** (`"seg nodeId subpath index"`) in `anchors`: one list to reset, but every existing reader would have to filter segments out, and a missed one would treat a segment as an Anchor.
- **Segments as Anchor pairs**: selecting both end Anchors means something else in Illustrator (Delete removes the Anchors and their neighbours' segments), so a segment needs its own state.
