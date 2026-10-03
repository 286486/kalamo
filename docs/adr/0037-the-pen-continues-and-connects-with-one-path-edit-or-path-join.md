---
status: accepted
date: 2026-09-27
---

# The Pen continues and connects paths with one `path_edit`, or one `path_join`

The Pen continues an open path from an Endpoint and connects the path it draws to another open path's Endpoint (#81, F-DRAW-04, research 06 §1). ADR-0032 has each finished path commit as one Transaction, and each browser Command takes an MCP tool's input.

## Decision

**Continuing is one `path_edit` with a single `set_d`.** A press on the Endpoint of a visible, unlocked open path starts from that path. Its subpath, in document coordinates and turned to end at the Endpoint, is the path so far. While drawing, the browser previews the `set_d`, so the path shows in its own Fill and Stroke. Enter, Esc or a tool switch sends it. A click on the path's other Endpoint closes it. Ctrl+Z removes new Anchors only; undoing past them leaves the path unchanged. The subpath keeps its direction.

**A new path connecting to an Endpoint is one `path_edit` on that path.** The existing path continues backwards through the new Anchors and keeps its id and appearance.

**Continuing a path onto another's Endpoint is one browser Command, `path_join`: a `path_edit` input, then a `path_op` Join input, in one Transaction.** The edit ends the continued path on the other Endpoint, and Join merges the two Endpoints at a tolerance of 0.05. Join keeps the topmost path and deletes the other, as Object > Path > Join does. No single MCP tool does both. An Agent does the same with `path_edit` then `path_op` inside a Transaction (ADR-0008). (ADR-0111 amends this: the Endpoints must meet once the edit applies, or the Document DO rejects the command with `ENDPOINTS_APART`; an Agent's Join is unchanged.)

**Continuing from a Smooth Endpoint starts a straight segment.** An open subpath's `d` has no outgoing Handle at its last Anchor, so there is none to keep. This follows Adobe's Illustrator-specific note; research 06 open question 2 still needs a live check, and a curved start would need the Handle kept outside `d`. A drag on the Endpoint pulls out a new Handle, as a drag on the last Anchor does while drawing.

**Alt with the Pen is the Anchor Point tool only when not drawing.** While drawing, Alt keeps its Pen meaning of breaking the Handles being dragged (ADR-0032).

**Auto Add/Delete, and the Add Anchor Point (+), Delete Anchor Point (−) and Anchor Point (Shift+C) tools, each send one `path_edit`.** Deleting a path's last segment deletes the path. The Endpoint check comes first, so a press on a selected path's Endpoint continues it and does not delete the Anchor.

## Consequences

- If the other path is on top, the connected path takes its appearance.
- These are not implemented yet: the Pen's cursor icons, Disable Auto Add/Delete, Alt-drag with the Anchor Point tool to re-pair Handles, reshaping a segment with the Anchor Point tool or Alt+Pen, and Ctrl temporarily switching to a selection tool.
