---
status: accepted
date: 2026-09-27
---

# A drawn path commits once when finished, an Anchor's type is derived from its Handles, and Convert to Path keeps the Node

M1 adds the Pen, Curvature and Pencil tools, Direct Selection and the `Object > Path` commands (#73). Three model questions come with them: when a path someone is drawing becomes part of the Document, whether an Anchor's Corner or Smooth type is stored, and what a Live Shape becomes when someone edits one of its Anchors.

## Decision

**A path being drawn stays in the browser until it is finished.** While the Pen or Curvature tool draws, the browser shows the path as a local preview, the way it previews a drag (ADR-0010). Enter, Esc, a click on the first Anchor or a switch to another tool finishes the path, and the browser sends it as one `create` Command, which commits one Transaction as the User Actor. Continuing an existing open path sends one `path_edit` instead. Ctrl+Z while drawing removes the last Anchor locally and sends nothing. A Pencil stroke is one Transaction, as it is in Illustrator.

After the commit, undo removes the whole path. Illustrator steps back one Anchor at a time instead. Zibel differs because the Document has one undo stack for every Actor (ADR-0011): per-Anchor Transactions would interleave with an Agent's edits, and each Anchor after the first would have to wait for the server to return the new Node's id.

**An Anchor's type is derived from its Handles.** `d` keeps its format (absolute `M L C Q Z`, §6.5). Core converts `d` to a list of Anchors and back. Each Anchor has the shape `path_edit` uses: `{anchor, handleIn, handleOut, type}`. An Anchor whose two Handles are collinear is Smooth. Any other Anchor, including one with a missing Handle, is Corner. Setting an Anchor's type moves its Handles so the rule gives that type. Zibel stores no per-Anchor flag, and Inkscape's `sodipodi:nodetypes` is not read (ADR-0017).

**Convert to Path keeps the Node.** An Anchor-level edit on a Live Shape converts it first (F-PATH-07), and so does `path_op` `convert_to_path`. The Node keeps its id, parent, fractional `index`, name and appearance, while its `type` becomes `path` and its geometry becomes the `d` that `shapeSegments` derives. This conversion is the only core edit that may change a Node's `type`, and `node_update` still refuses to. Undoing it restores the Live Shape and removes the keys it added (`d`, `fillRule`).

## Considered Options

- **Commit each Anchor as it is placed.** This matches Illustrator's undo and lets collaborators watch the path grow. It was rejected because of the shared undo stack and the id round trip described above.
- **Commit the path at its first Anchor, then update `d` for each Anchor.** This has the same undo interleaving, and a one-Anchor path would sit in the Document while the person is still drawing.
- **Store a type on each Anchor.** Illustrator stores one, and Inkscape stores `sodipodi:nodetypes`. That would need a parallel array beside `d` that every path edit keeps in step, plus import and export in the SVG dialect, just to preserve a Smooth Anchor whose Handles are no longer collinear. Illustrator itself converts such an Anchor to Corner once its Handles are moved independently.
- **Convert to Path by creating a new path and deleting the Live Shape.** This needs no new core rule. It was rejected because the Node would get a new id, which breaks an Agent's references and the person's Selection, and Illustrator keeps the object.

## Consequences

- The browser gains a `create` Command. `path_edit` and `path_op` become Commands that parse the same schemas as their MCP tools.
- The undo of a type change is a new case in the per-key revert of ADR-0011: keys present only after the change are removed.
- A file that marks an Anchor Smooth while its Handles are not collinear opens with that Anchor as Corner.
