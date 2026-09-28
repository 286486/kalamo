---
status: accepted
date: 2026-09-29
---

# Isolation Mode also isolates a sub-Layer or a single path

ADR-0057 isolates only Groups. Illustrator also isolates a sublayer, from the Layers panel menu's Enter Isolation Mode, and a single path, by a double-click with the Selection tool (#130). Isolating a sub-Layer is also how a designer reaches the unpainted Clipping Path of a Layer Clipping Mask (ADR-0053) on the canvas. This ADR amends ADR-0057. Every rule there that says "Group" now says "isolated Node" unless this ADR says otherwise.

## What Illustrator does

- **Sublayers.** The Layers panel menu's Enter Isolation Mode isolates the targeted sublayer. It is greyed out for a top-level layer. The Layers panel then shows only the sublayer. Exit Isolation Mode goes up one level: "if you have isolated a sublayer, select Exit Isolation Mode multiple times". So each sublayer between the top-level layer and the isolated artwork is a level of its own.
- **A single path.** A double-click with the Selection tool on a path that is not in a group isolates the path. The context menu offers Isolate Selected Path. Everything else dims, and the path can be edited alone. A double-click on text starts text editing instead.
- **Drawing while a path is isolated.** Users report that art drawn or pasted while a path is isolated is grouped with that path. Illustrator creates the group.

The sources are those of ADR-0057: Adobe's "Isolate objects" page as search results quote it, tutorials, and community threads. Adobe's help does not say whether an Image can be isolated.

## The rule

- **What can be isolated.** A Group, a Clip Group included (ADR-0057). A sub-Layer, meaning a Layer whose parent is a Layer, a clipped one included. A single Live Shape or Path that is not a Clipping Path. A top-level Layer, a text, an Image and a Clipping Path cannot be isolated. The Node and every ancestor must be visible and unlocked, as before.
- **Levels.** The levels are the isolated Node and every Group and sub-Layer above it, up to the top-level Layer. They are still derived from the tree. So a Group double-clicked inside a sub-Layer has the sub-Layer as the level above it, and Esc from the Group isolates the sub-Layer. This is the same whether the sub-Layer was isolated first or not.
- **Scope.** A sub-Layer scope works as a Group scope: its children are the outermost objects, and its descendants are the reach of a marquee, Select > All, Select > Inverse and Direct Selection. A leaf scope holds one object, the leaf itself. A click on it selects it. A marquee, Select > All and Inverse select it or nothing. Direct Selection reaches only its anchors. Hits on anything else miss, and every ancestor clip still applies.
- **The Clipping Path.** In an isolated clipped sub-Layer, an unpainted Clipping Path hits on its outline, and an unpainted text Clipping Path on its frame's edges, as ADR-0057 says for a Clip Group. A top-level Layer Clipping Mask cannot be isolated, so its unpainted Clipping Path is still reached from its Layers panel row.
- **Enter by double-click.** A double-click with the Selection tool on an object that can be isolated isolates it. A Live Shape or Path now counts, which replaces ADR-0057's "a double-click on a leaf only selects it". The second click then acts as a click in the new scope, so the double-clicked leaf is selected. A double-click on a text, an Image or a Clipping Path only selects it. A double-click on the isolated leaf itself selects it and goes no deeper.
- **Enter from the Layers panel.** The panel's foot gains an Enter Isolation Mode button, Illustrator's panel menu item, next to Make/Release Clipping Mask. Zibel's panel has no menu and no layer targeting, so the button acts on the deepest Layer that holds every selected Node. After a click on a Layer row, which selects its objects, that is the Layer itself. The button is enabled when that Layer is a sub-Layer, can be isolated, and lies strictly inside the current scope. It is disabled with nothing selected, and while a Group or a leaf is isolated, since no Layer lies inside those. It leaves the Selection empty. A viewer can use it, as a viewer can isolate by double-click (ADR-0057).
- **Enter from the menu.** The Object menu gains Isolate Selected Path, Illustrator's context-menu name, below Isolate Selected Group. It is enabled for a Selection of exactly one Live Shape or Path that can be isolated. The leaf stays selected. Isolate Selected Group is unchanged.
- **Exit and breadcrumbs.** Exit is unchanged. Each Esc, back arrow, Object > Exit Isolation Mode or double-click on nothing in scope goes up one level and selects the Node just left. For a sub-Layer, which is never selected itself, the Selection becomes empty. The bar shows the top-level Layer, then each level by name or Auto-name. A sub-Layer crumb goes to that level. The top-level Layer crumb leaves Isolation Mode.
- **New art.** In a sub-Layer scope, new art from the drawing tools, Paste, Paste in Place, File > Place and drops goes into the sub-Layer, on top, or into the nearest Layer in scope that holds the first selected Node, as outside Isolation Mode. In a leaf scope, a leaf cannot hold children and Zibel has no Group command. So the art goes where it would go one level up: into the leaf's parent, on top. The Isolation first goes up one level, and the new art is then selected as after any create. Nothing changes when no art is created: a Place, drop or Paste goes up only once the Worker accepts it, and not if the tab or its Isolation changed meanwhile (#136). In a Clip Group the art is clipped.
- **When the tree changes.** ADR-0057's pruning also drops a level that can no longer be isolated: a leaf that became a Clipping Path, or a sub-Layer that became a top-level Layer. A leaf that a Path operation or Convert to Path replaces with a new Node is deleted, so the Isolation goes up from it. Releasing a clipped sub-Layer leaves it isolated.
- **Layers panel.** The isolated sub-Layer's or leaf's row is the root, at depth 0. A sub-Layer root starts expanded, and its name selects its objects, as any Layer row does. A leaf root's name selects the leaf. The Make/Release Clipping Mask button is enabled in a sub-Layer scope when its target, the nearest Layer holding the first selected Node or else the isolated sub-Layer, lies in the scope. It stays disabled in a Group or leaf scope.
- **Drawing.** The browser canvas draws the isolated sub-Layer or leaf in the context of its ancestors over the faded Document, as for a Group. `render`, export, the clipboard and the round trip do not change.

## Considered Options

- **Isolate a top-level Layer too.** Illustrator does not. Hiding or locking the other Layers already gives the same focus, and the bar would then show a crumb that is itself the level.
- **Sub-Layers as breadcrumbs that are not levels.** Esc from a Group would then leave Isolation Mode even when its sub-Layer was isolated first, unless the levels were a stack. ADR-0057 rejected a stack because it can disagree with the tree. Illustrator's "select Exit Isolation Mode multiple times" says sublayers are levels.
- **A double-click on a sub-Layer's row.** Illustrator uses a row's double-click for renaming and Layer Options, which Zibel will want. A foot button keeps the row's gestures free and sits beside the Layer command the panel already has.
- **The foot button on Make/Release's target**, the nearest Layer holding the first selected Node (ADR-0053). A click on a sub-Layer row selects its objects in draw order, so the first one can sit in a deeper sub-Layer, and the button would isolate the wrong Layer. The deepest Layer holding every selected Node is the same Layer whenever the Selection is inside one Layer.
- **Group the leaf with new art, as Illustrator does.** Zibel has no Group command or reparent (#54) to build it from. Going up one level keeps the new art visible and selectable. When a Group command lands, a later issue can match Illustrator.
- **Refuse new art while a leaf is isolated.** A tool that silently does nothing is worse than a tool that leaves one level.
- **Isolate Images and texts.** A text's double-click belongs to text editing (F-TEXT) when it lands. An Image has no parts to edit alone, and Adobe's help does not say that Illustrator isolates one.
- **Isolate a Clipping Path alone.** In an isolated Clip Group or sub-Layer it is already selectable and editable on its own (ADR-0057). Illustrator's Edit Clipping Path is a separate command, left out as in ADR-0057.

## Consequences

- The scope helpers of ADR-0057 take a Node that is a Group, a sub-Layer or a leaf. "Is this Node in scope" includes a leaf scope itself.
- Double-clicking a Group inside a sub-Layer now takes two exits instead of one. The tests written for #53 that assume one exit there change with this ADR.
- The Layers panel's foot holds two buttons. The Object menu holds Isolate Selected Group, Isolate Selected Path and Exit Isolation Mode.
- No change to core, the Document schema, the sync protocol, MCP, `render`, SVG or `.zibel.json`.
