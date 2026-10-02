---
status: accepted
date: 2026-10-03
---

# The Attributes panel sets a fill rule and a subpath direction

ADR-0018 models a Compound Path's holes by `fillRule` and subpath direction, after Illustrator's Attributes panel. ADR-0107 built Make and Release. In the browser, the only way to change either was Object > Path > Reverse Path Direction, which reverses every subpath of the selected paths. An Agent could already do both, with `node_update` `fillRule` and `path_edit reverse` with one `subpath`. This ADR adds Window > Attributes with Illustrator's two Compound Path controls (#270) and records which of Illustrator's rules it follows.

## Sources

- Adobe, *Create compound paths in Adobe Illustrator* (helpx.adobe.com/illustrator/desktop/manage-objects/reshape-transform-objects/create-compound-paths.html). It has the steps "Select Window > Attributes", then choose Use Non-Zero Winding Fill Rule or Use Even-Odd Fill Rule. Under nonzero, "you can change the areas that have fills and holes by reversing the path direction in the Attributes panel": "with the direct-selection tool, select the part of the compound path to reverse. Do not select the entire compound path", then click Reverse Path Direction Off or On. The page defines nonzero by a ray's net crossing count, where zero is outside. Adobe's servers refuse automated reads, so these phrases were checked through search excerpts of that page on 2026-10-03, as for ADR-0107.
- Webdesign.org, *Illustrator Compound Paths* (webdesign.org/vector-graphics/adobe-illustrator/compound-paths.12810.html): "Use Group Selection tool to select just the path which direction you want to change… In the Attributes palette box, click the direction button that is not pressed." So the two buttons show the subpath's direction and set it. They are not one toggle.
- Adobe Community, on PathItem `polarity`: when Compound Path > Make runs on objects that were never part of a compound path, Illustrator "makes the bottom path positive and all the rest negative", and so every path except the bottom one becomes a hole. Scripting has `PolarityValues.POSITIVE` and `NEGATIVE` on every PathItem (Adobe Illustrator Scripting Guide, PathItem). The guide does not say which polarity runs which way.
- Adobe Community, *Reverse path direction*: before Illustrator added Object > Path > Reverse Path Direction, "the 'reverse path direction' button is in the Attributes panel, but it's only available for compound paths". Research 06 §Path records the same.
- Illustrator's shortcut for Window > Attributes is Ctrl+F11 on Windows and Cmd+F11 on macOS.

## Decision

**Window > Attributes (Ctrl+F11)** shows a panel in the dock between Pathfinder and Layers. It is checked while open, like Layers, Gradient and Pathfinder. It has two rows of buttons. Each button sets one value and shows as pressed while every target has that value. When the targets differ, neither button in the row is pressed. When the Selection gives a row nothing to set, its buttons are disabled.

- **Fill rule: Use Non-Zero Winding Fill Rule and Use Even-Odd Fill Rule.** The targets are the editable `path` Nodes in the Selection, and the editable paths in a selected Group. A Group's paths are the leaves that Make takes from it (core's `operandLeaves`), so never a Clipping Path, an Opacity Mask or what a mask holds. A Live Shape, a text and an Image are not targets: ADR-0018 gives only a `path` a `fillRule`, because their outlines never cross themselves. Locked and hidden Nodes, and a viewer's tab, have no targets. A plain one-subpath path is a target, as in Illustrator, because its outline can cross itself. A press sends one `fill_rule` command for the targets whose rule differs. When none differ, it sends nothing.
- **Reverse Path Direction Off and On.** The targets are the subpaths that hold a Direct Selection Anchor or segment, in an editable Compound Path (two or more subpaths) whose rule is nonzero. Adobe documents the control only for nonzero, where direction decides the holes. Under evenodd, direction draws nothing different. A one-subpath path is not a target: Illustrator kept these buttons for compound paths, and Object > Path > Reverse Path Direction reverses a whole path. A Compound Path selected whole, with the Selection tool or as a Layers row, has no chosen subpath, so the buttons stay disabled, as Adobe's "do not select the entire compound path" asks. A press reverses each target subpath that does not already run the pressed way. It sends one `path_reverse` command, which reverses each one with `path_edit reverse` and its `subpath`. When none differ, it sends nothing. The chosen Anchors stay chosen, renumbered as the reverse renumbers them, so the panel goes on showing the direction it set.
- **On and Off name a direction on screen.** Neither Adobe nor the scripting guide says which visual direction is positive. Kalamo defines On as a subpath that runs clockwise on screen, measured in document coordinates after every transform, with each cubic's signed area exact. Off is counter-clockwise. Kalamo's Live Shapes run clockwise, and Make reverses the backmost (ADR-0107). So a Make result reads as Illustrator's does: the backmost is Off and the holes are On, the bottom path positive and the rest negative. A unit test checks this on a Make of two concentric circles.
- **One write each.** Each press is one Transaction with one WriteReceipt and one undo step. `fill_rule` and `path_reverse` are browser commands only. Their Durable Object entries write through `updateNodes` and core's `editPath`, which `node_update` and `path_edit` use too. One command covers several paths, so a Selection that spans two Compound Paths still undoes in one step.
- **No new Agent operation.** `node_update` sets `fillRule` on any number of paths, and `path_edit reverse` with `subpath` reverses one subpath. An Agent reads a subpath's direction from the `d` that `node_get` returns. The panel needs nothing they cannot express.
- **The shortcut.** Ctrl+F11 is bound like the other Window items, by `keysOf`, with Cmd as Ctrl on macOS. Browsers keep F11 alone for full screen. Chrome's and Firefox's published shortcut lists give nothing to Ctrl+F11, so the page receives it. The e2e test presses it in Chromium. Playwright's input does not pass through every browser-level shortcut, so the test cannot prove that a real browser lets it through. If one keeps it, the rule of ADR-0031 for reserved shortcuts applies, and Window > Attributes still works from the menu.

## Considered Options

- **One toggle button for Reverse Path Direction.** Rejected: Illustrator's two buttons set a direction and show it, and a toggle could not show a mixed state.
- **Several `path_edit` commands, one per path.** That is what a Direct Selection drag does. Rejected for the panel: a press that spans two Compound Paths would take two undo steps.
- **Enabling Reverse Path Direction under evenodd as well.** Rejected: there it changes nothing that shows, and Adobe documents the control only for nonzero.
- **Fill rule on Live Shapes,** converting them to paths. Rejected: their outlines never cross themselves, so the rule would change nothing and would only cost the Live Shape.
- **On defined relative to the backmost subpath.** Rejected: the backmost would then have no direction of its own, and Illustrator stores polarity on each path.

## Consequences

- Hidden and locked paths are left out, as the other panels leave them. An Agent can still set their rule.
- The Direct Selection's highlight follows the renumbered Anchors. Another Actor's edit to the same path still clears it, as for any Direct Selection.
