---
status: accepted
date: 2026-09-30
---

# `node_duplicate` and Alt-drag copy Nodes with new ids

REQUIREMENTS §6.4.4 lists `node_duplicate {docId, nodeIds[], offset?, count?, targetParentId?}` returning a map from each source id to its new ids, and F-XFORM-01 (P0) asks for Alt-drag copy. Neither existed. The nearest code was Place's private re-id closure, used when pasting Kalamo's own Copy. It turns Layers into Groups and strips `clipping`, so it could not serve (#193).

Kalamo follows Illustrator (REQUIREMENTS §2). Adobe's help and Adobe staff answers on Illustrator's UserVoice say:

- An Alt-drag's copies go as one block directly above the topmost selected object, in the originals' order. Selected objects from other groups or layers are pulled into that object's parent. Adobe staff confirmed this is intended and has been the behaviour since Illustrator 10. InDesign instead puts each copy above its own original.
- The modifier state when the mouse button is released decides. Alt can be pressed or released during the drag, and releasing Alt first cancels the copy.
- The copies become the Selection, which Transform Again relies on.
- Canvas copies keep their names. Only the Layers panel's Duplicate adds " copy" (#195).
- In Isolation Mode the copies stay in the isolated container.

## The rule

- **One core edit, two entry points.** `duplicateNodes(doc, input)` in core serves `kalamo_node_duplicate {docId, nodeIds, offset?, count?, targetParentId?, intent?, txId?, ifRev?}` (1 to 1000 ids) and the browser's `duplicate` Command. The DO runs both through the same method.
- **A copy is the Node with a new id.** Each listed Node is copied with its whole subtree. Every copied Node gets a new id, a parent among the copies or the placement's parent, and a new key. Nothing else changes: name, visibility, lock, opacity, blend mode, transform, Appearance, Live Shape and `compound_shape` parameters, text, tags, meta, and an Image's `src` and `file`. An Image's pixels are shared by hash. The R2 sweep counts every `src` (ADR-0046), so deleting the original never frees a copy's pixels.
- **Beside the original** (no `targetParentId`): each copy lands directly above its own original, in the original's parent. A Layer's copy stays a Layer. Nodes in several parents are each copied in their own. This is the MCP default because an Agent naming Nodes in several parents rarely means "move them all into one".
- **Into a target** (`targetParentId`, a Layer or Group, or `null` for the top level): all copies go there as one block, in the originals' paint order, whatever order `nodeIds` gives. By default the block goes on top. Core also takes `index`, `before` or `after`, which mean what they mean in `node_reparent` (ADR-0071), counted among the target's current children; the browser sends `after`. MCP does not publish those three: an Agent that needs an exact place follows with `node_reparent`. A position without `targetParentId` is `INVALID_INPUT`.
- **`offset` and `count`.** `count` (an integer 1 to 100, default 1) copies of each Node. Copy *k* is translated by *k* × `offset`, as a chain of Transform Again after one Alt-drag would place it. Beside the original, copies stack upward in order *k* = 1…`count`. Into a target, the block repeats per step: every original's copy 1, then every original's copy 2.
- **Outermost only.** A Node listed together with its ancestor is copied only through the ancestor. A repeated id is copied once. The receipt's map has one entry per Node actually copied.
- **Clipping.** A top-level copy of a Clipping Path loses `clipping`, as a moved one does (ADR-0071) and as a pasted one does (ADR-0053). Copied beside itself in its Clip Group it would otherwise be a second Clipping Path, which ADR-0072's tree rule forbids. The original keeps clipping. A copied Clip Group or clipped Layer keeps its Clipping Path, so the copy still clips.
- **Tree rules.** A copy whose parent would break them, such as a Layer into a Group or a target inside a copied Node, is refused with `INVALID_PARENT`, `path` `targetParentId`, and nothing is written.
- **Locks bind people, not Agents** (ADR-0027). The edit does not check `locked`. The browser copies only what a plain drag would move.
- **One write.** One Transaction, one WriteReceipt, `rev` +1 and one undo step (ADR-0011). `createdIds` lists every new Node, descendants included. The receipt adds `copies`: each copied source id mapped to its new top-level ids, in order *k* = 1…`count`, and `geometricBounds`: each of those top-level copies' geometricBounds in document coordinates, read from the written Document, so an Agent sees where each copy landed without a `kalamo_node_get` (#235). Errors: `NODE_NOT_FOUND` with `path` `nodeIds[i]` or `targetParentId`, `INVALID_PARENT` as above, and `INVALID_INPUT` for a `count` out of range or an unknown key: the input schema is strict (ADR-0050). There is no `partial`, because a half-made copy set has no use.

## The browser: Alt-drag with the Selection tool

- **Alt at release decides.** A Selection-tool drag whose Alt key is down when the button is released sends a `duplicate` Command instead of `transform`. Pressing Alt after the drag starts still copies. Releasing it before the button moves.
- **The preview follows Alt.** While Alt is down, the originals stay and the copies show at the pointer. Pressing or releasing Alt switches the preview at once, without the pointer moving. The preview runs the same core edit on a copy of the Document.
- **What is copied** is the same editable set a plain drag moves, outermost only: a Node dragged with its ancestor is copied through the ancestor, and the topmost is picked among the outermost.
- **Where.** The copies go into the topmost dragged Node's parent, directly above that Node (`after` it), as one block, translated by the drag delta. This is Illustrator's rule. A drag whose Nodes include a Layer, possible only when the Layers panel selected it, copies each Node directly above its own original instead: a Layer cannot join a Group's block, and a drag should not make a top-level Layer a nested Layer. In Isolation Mode the dragged Nodes are inside the isolated Group or nested Layer, so the copies stay in it. An isolated leaf's copies land beside it, so the Isolation goes up one level, as new art does (#137).
- **The copies become the Selection.** The DO's `tx` answers the Command by `commandId`, and its `created` Nodes are this Command's own. The browser selects the created Nodes whose parent is not also created, a copied Layer as its row's click selects it (see "The Layers panel's Duplicate"). Other Commands' `tx` answers keep their selection behaviour: `path_op`'s is unchanged.
- **Viewers.** A viewer's Selection-tool press selects but starts no move and no copy, so a viewer's drag sends nothing. The server still refuses a viewer's Commands with `PERMISSION_DENIED` (ADR-0047).
- **Shift and Smart Guides.** The drag-move has neither a Shift constraint nor Smart Guides yet. The copy is one Command sent at release from the same drag, so when the move gains them, Alt-drag has them too.

## The Layers panel's Duplicate

Amended by #195. Illustrator's Layers panel menu has Duplicate "<name>" (Duplicate Selection for several rows); dragging a row onto Create New Layer and Alt-drag (#194) duplicate too. Adobe's help and community answers say the copy lands directly above its original in the same parent, " copy" is appended to the Layer's name and to every nested Layer's name with no setting to turn it off, the copy keeps the original's visibility and lock, and Duplicate works on every selected row, Layers and objects alike, each copy above its own original.

- **Entry point.** The panel's header gains a panel-menu button (☰) with one entry: Duplicate "<name>" when one row is selected, counting rows inside it as that row, and Duplicate Selection otherwise. The menu is a native `popover` with `role="menu"`: Enter or Space on the button opens it and focuses the entry, which shows the menu bar's focus colour. Enter or a click runs it, closes the menu and hands the keys back to the Document, as a menu bar command does. A disabled entry does nothing and the menu stays open, as in the menu bar. Escape closes the menu and returns focus to the button. The canvas leaves the keys to the menu while it is open. No main-menu entry or shortcut, as in Illustrator. The drag onto Create New Layer waits for the New Layer button.
- **Selected rows.** A Layer is never in the Selection (ADR-0012): its row selects its objects. Illustrator keeps two things apart here: the rows highlighted in the panel, which Duplicate acts on, and the selected art. Kalamo keeps them the same way. Beside the Selection, each Document Tab holds its Layer rows, browser state like the Selection. A click on a Layer's row makes it the only one. Shift+click toggles it and Alt+Shift+click removes it, keeping the rest, and its objects follow it as a group: all of them join the Selection when it turns on and all leave when it turns off, so toggling the row never leaves its art partially selected. Shift+click on another row keeps them all. A Layer row is highlighted like a selected Node's row. Any Selection change that does not set the Layer rows at the same time forgets them: a click on an object row, the canvas, Select All, Undo, an Agent deleting a selected Node. So they never come back because a later Selection holds the same Nodes, and an empty Selection counts too. An Agent's edit that leaves the Selection unchanged keeps them. Dragging a row still carries what it carried (ADR-0075).
- **Effect.** One `duplicate` Command beside the originals, with `layerSuffix: " copy"`: core appends it to the name of every copied Layer, the top one and each nested Layer, in the same Transaction and undo step. An empty name stays empty, since the auto-name `<Layer>` is never stored. Other Nodes keep their names. `layerSuffix` is the browser's only: MCP does not publish it, so `kalamo_node_duplicate` keeps every name.
- **What copies.** Visibility and lock are copied as they are, so a locked or hidden Layer, a Template Layer too, can be duplicated and its copy is locked or hidden. A clipped Layer and a Clip Group are copied whole and keep clipping. A row whose copy would land in a locked container, itself or through an ancestor, is skipped, because canvas locks bind people (ADR-0027); so is a row whose copy would land outside the isolated Node. With no row left, or for a viewer, the entry is disabled and nothing is sent.
- **Selection.** The copies become the Selection, as an Alt-drag's do. A copied Layer is selected as a click on its row selects it: it becomes a Layer row, and its objects join the Selection unless it is hidden or locked, itself or through an ancestor. No Layer ever enters the Selection. The rule is in the browser's handling of the answer, so an Alt-drag of a Layer row (ADR-0075) follows it too. Duplicate then Duplicate again copies the copy.

## Considered Options

- **Each copy above its own original on the canvas too**, as InDesign does. Rejected: Illustrator puts the block above the topmost object, and Adobe confirmed it is intended.
- **Alt at press decides.** Rejected: Illustrator reads the modifiers at release, and that lets a person change their mind mid-drag.
- **One offset for every copy.** Rejected: `count` would then stack copies on top of each other. Cumulative steps match Transform Again.
- **Reuse Place's re-id code.** Rejected: Place turns Layers into Groups and strips every `clipping` for the Paste rule. The issue also keeps Paste out of scope, so Place is unchanged.
- **Refuse a lone Clipping Path copied beside itself.** Rejected: Illustrator allows the copy, and ADR-0071 already drops `clipping` when a Clipping Path leaves its container.
- **Publish `index`, `before` and `after` in MCP.** Deferred: §6.4.4 does not list them, and `node_reparent` places a copy exactly.

## Consequences

- `reparentNodes` and `duplicateNodes` share one position rule (`slotOf`), so `index`, `before` and `after` mean one thing. `paintOrder` moved from `path-op.ts` to `document.ts` for both.
- `DocumentService` gains `duplicateNodes`, returning a `DuplicateReceipt`. The socket `ClientMessage` union gains `duplicate`.
- The Selection tool's `keyChange` watches Alt, and its press no longer starts a move for a viewer.
- Layers-panel Alt-drag (#194) and Duplicate Layer (#195) build on this edit. `DuplicateInput` gains the browser-only `layerSuffix`, and `keysTaken` covers every open `role=menu` popover, the panel menu's too.

## Telling an Agent where its copies are (#235)

An Agent that read a copy's `transform` beside its original's `x` sometimes deleted the copies and drew them again by hand: 2 of 6 `pnpm bench` grid runs on Opus 5.5, at about 4–5× the output tokens. The receipt now gives each top-level copy's `geometricBounds`, keyed by copy id, and the tool description and drawing-conventions say only that this is where the copy landed and that a copy there is finished. They do not say that a copy keeps its original's parameters and is moved by its `transform`. With that sentence in both, all 8 grid runs on Opus 5.5 (2026-10-02) skipped `kalamo_node_duplicate` and wrote all 100 rects by hand, at about 9–11k output tokens and $0.45 a run. With the receipt and the shorter wording, 3 of 5 runs kept their copies (2.3–2.6k output tokens, $0.30–0.32 warm), 2 wrote the other 99 by hand without duplicating, and none deleted copies. With main's wording, 4 of 6 runs duplicated and 1 of those deleted its copies and redrew them. How a copy is stored has not changed: it still keeps its parameters and is moved by its `transform`, as Alt-drag does.

