# Illustrator drawing tools: exact behaviour (research notes, 2026-09-27)

Target: Adobe Illustrator 2025/2026 desktop. Primary source is the Adobe Illustrator user guide on helpx.adobe.com. In 2025 Adobe split the old long pages (`/illustrator/using/...`) into many short pages (`/illustrator/desktop/...`), last updated Oct 2025 to May 2026. The short pages drop detail, so the older long pages (Wayback Machine snapshots from Dec 2024) are quoted where they hold facts the new pages leave out.

Legend: **[A]** the Adobe doc states it. **[A-old]** stated in the Dec 2024 Adobe doc and not contradicted by the new pages. **[C]** community or third-party source. **[U]** unverified: my recollection of the product, to check in a live Illustrator before relying on it.

Access note: helpx.adobe.com returns 403 to WebFetch. A plain `curl` with a browser User-Agent and `Accept: text/html` works.

---

## 1. Pen tool (P)

Sources:
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-line-segments-with-the-pen-tool.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-curves-with-the-pen-tool.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-two-curved-segments-connected-by-a-corner.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-curves-followed-by-straight-lines.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-straight-lines-followed-by-curves.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/preview-paths-drawn.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/turn-off-automatic-addition-or-deletion-of-anchor-points.html
- Old long page (Dec 2024): https://web.archive.org/web/20241230205225/https://helpx.adobe.com/illustrator/using/drawing-pen-curvature-or-pencil.html
- Extending and connecting paths: https://helpx.adobe.com/illustrator/using/adjust-path-segments.html

**Placing anchors**
- Click (no drag) places a **corner point**. The first segment shows only after the second click. [A]
- Shift-click constrains the segment angle to a multiple of 45°. [A]
- Press and drag places a **smooth point**. The drag sets the outgoing direction line, and the opposite handle mirrors it, so the handles are equal in length and collinear. Shift constrains the handle to multiples of 45°. [A-old]
- Holding **Ctrl/Cmd while dragging** the handles of a smooth point makes them **unequal in length but still paired** (collinear). [A] (Tip on the new curves page and the preview page.)
- **Alt/Option-drag** a direction line breaks the handles and makes a **cusp** (corner point with independent handles). The documented flow: drag out the smooth point, then without releasing the mouse, hold Alt and swing the direction line. Release the key and the mouse. [A]
- **Spacebar while the mouse is down**: "After you click to create an anchor point, keep the mouse button pressed down, hold down the spacebar, and drag to reposition the anchor point." [A-old] The shortcuts page lists this as "Move current anchor point while drawing with Pen tool: Spacebar-drag". [A]
- The last anchor shows as a solid (selected) square. Earlier anchors become hollow (deselected). [A-old]

**Converting the current endpoint while drawing**
- Hover the Pen over the selected endpoint you just placed and a convert-point icon appears. **Click it** to delete the outgoing handle, turning smooth into corner, so the next segment starts straight. **Drag from it** to pull out a new outgoing handle, for a straight-then-curve sequence. [A]

**Rubber band preview**
- On by default for the Pen and Curvature tools. It previews the segment from the last anchor to the pointer. Turn it off in Preferences > Selection & Anchor Display > "Enable Rubber Band for: Pen Tool / Curvature Tool". [A]

**Closing**
- Hover over the first (hollow) anchor and a small circle appears next to the pointer. Click, or drag, to close. [A]
- Dragging on the closing anchor shapes its handles. While closing, **Space** repositions the closing anchor and **Alt/Option** breaks the pairing of the closing anchor's handles. [A-old]

**Ending an open path**
- Ctrl/Cmd-click away from all objects. [A]
- Or pick another tool, or Select > Deselect. [A]
- Or press Enter/Return. [A-old]
- Or press Esc: "When the preview is on, pressing Esc stops showing the preview and ends the path. This is the same action as hitting the keyboard shortcut P while working with the Pen tool when the preview feature is off." [A]
- Holding Ctrl/Cmd while the Pen is active temporarily switches to the last-used selection tool, so you can adjust segments already drawn. [A] (adjust-path-segments)

**Continuing an existing open path**
- Hover the Pen over an endpoint of an open path and the pointer changes. Click the endpoint, then keep clicking or dragging to extend the path. [A]
- Clicking the endpoint of *another* open path while drawing shows a merge symbol and **connects** the two paths into one. [A]
- The docs contradict themselves on continuing from a **smooth** endpoint. The shared text says "the new segment will be curved by the existing direction line", but the Illustrator-specific note says "if you extend a path that ends in a smooth point, the new segment will be straight." [A] Needs a live test [U].

**Auto Add/Delete**
- Over a **selected** path, the Pen turns into the Add Anchor Point tool on a segment and into the Delete Anchor Point tool on an anchor. [A]
- Hold **Shift** while hovering to override this temporarily, for example to start a new path on top of an existing one. Release Shift before the mouse button so the path is not constrained. [A]
- Preferences > General > **Disable Auto Add/Delete** turns it off permanently. [A]

**Pen modifiers**
- Alt/Option with the Pen active switches it to the Anchor Point (Convert) tool. [A] (shortcuts page)
- Alt/Option held over a *segment* shows the Reshape Segment cursor, and dragging the segment reshapes it. [A]
- Shift while reshaping constrains the handles perpendicular to the segment and keeps them equal in length, which gives a semicircle. [A]

**Related tools**
- **Add Anchor Point tool (`+`)**: click a segment to add an anchor. [A]
- **Delete Anchor Point tool (`-`)**: click an anchor to remove it, and the path stays connected. [A] Alt toggles between the Add and Delete tools. [A]
- **Anchor Point tool (Shift+C)** [A]:
  - Clicking a smooth point makes a corner point with no handles.
  - Dragging out of a corner point makes a smooth point.
  - Dragging one handle of a smooth point breaks it into a cusp.
  - Alt-dragging a handle re-pairs it with the opposite handle, so the point becomes smooth again.
  - Dragging a segment reshapes it; Alt copies it; Shift makes a semicircle.

**Undo while drawing** [U/C]
- Adobe does not document this. From product behaviour: Ctrl/Cmd+Z removes the last anchor, and the path stays selected with its new last point as the active endpoint, so the next click keeps extending the same path. Undo is per anchor.
- One community report says the outgoing handle can be lost when you continue after an undo (https://community.adobe.com/t5/illustrator-discussions/lost-bezier-anchor-point-handle-when-continuing-path/m-p/10609081).
- Verify both points live.

**Appearance of a new path**
- New paths take the current fill and stroke. The Pencil doc says so outright ("The path takes on the current stroke and fill attributes"). [A-old]
- The Appearance panel option **New Art Has Basic Appearance** (on by default) strips effects and multiple fills/strokes from new art. Turn it off to draw with the full current appearance. [A] (Pencil page note)
- Where the new object goes in the stacking order follows the Drawing Mode (Shift+D) [A]:
  - Draw Normal: above the selected object, or at the top of the current layer.
  - Draw Behind: directly below the selected object, or at the bottom of the layer.
  - Draw Inside: clipped into the selected object.
  - Source: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/learn-drawing-basics/drawing-modes-overview.html

## 2. Curvature tool (Shift+~)

Sources:
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-shapes-with-the-curvature-tool.html
- Old long page: https://web.archive.org/web/20241230205225/https://helpx.adobe.com/illustrator/using/drawing-pen-curvature-or-pencil.html

**Drawing**
- Click to set the first point, then click again. The first two points make a line segment, and moving the pointer then shows the rubber-band preview of the resulting curve. [A]
- A **click creates a smooth point**. The curve is interpolated through the clicked points; you never drag handles. [A]
- To make a **corner point**, **double-click**, or **Alt-click while placing** the point. [A-old] The new page mentions only double-click. [A]

**Editing**
- **Alt/Option-click** continues adding points to an existing path or shape. [A]
- **Double-click an existing point** toggles it between smooth and corner. [A]
- Click a point and drag to move it. [A]
- Select a point and press **Delete** to remove it: "the curve is maintained", meaning the path stays connected and is re-interpolated. [A]
- **Esc** stops drawing. [A] Esc also ends the path when the rubber band is on (same note as for the Pen). [A]
- Clicking a segment of the path being drawn adds a point. [U]

**Closing** [U]
- Not stated in the docs. Clicking the first point closes the path, and the pointer shows a close indicator the way the Pen does.
- Zibel (#82) closes on a click on the first Anchor, once the path has two, as its Pen does; a drag on it moves it instead. Not yet checked against a live Illustrator.

**Shortcut**
- The shortcuts page writes it as "Shift + ~" on both Windows and macOS. On US layouts that is the backtick/tilde key (`` ` ``/`~`) with Shift. [A]

## 3. Pencil tool (N), Smooth tool, Path Eraser

Sources:
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-freeform-paths-with-the-pencil-tool.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/draw-straight-lines-with-the-pencil-tool.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/pencil-tool-options.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/extend-paths-with-the-pencil-tool.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/reshape-paths-with-the-pencil-tool.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/draw-shapes/connect-two-paths-with-the-pencil-tool.html
- Old long page (above), for closed paths and Fidelity.

**Drawing**
- Drag to draw. A small star (older docs say "x") on the cursor means a new freeform path. [A]
- Anchor points are placed automatically, at the ends and along the path. Their number depends on path length, complexity and Fidelity. [A-old]
- The path stays selected by default. [A]
- **Shift-drag** draws a straight segment constrained to 0/45/90°. [A]
- **Alt/Option-drag** draws an unconstrained straight segment. [A]
- For a polyline, keep Shift or Alt held, hover the endpoint until the continuation icon shows, and drag again. Or, while keeping the mouse down, release and re-press the modifier to start the next segment. [A-old]
- **Close**: draw back toward the start point and release when the small circle appears. [A] The old method still documented in Dec 2024: start dragging, hold Alt, release the mouse (then Alt), and the tool closes the path with the shortest line back to the start. [A-old] This conflicts with Alt meaning "straight line" in current versions, so treat the Alt-close as legacy [U].

**Editing with the Pencil**
- **Extend**: select the path, hover an endpoint until the continuation icon appears, then drag. [A]
- **Connect two paths**: select both, drag from an endpoint of one to an endpoint of the other, and release when the continuation icon appears. [A]
- **Redraw/reshape**: select the path and start dragging on or near it (within "Edit selected paths: Within N px"). When the star disappears from the cursor, the stroke replaces that portion of the path. This can accidentally open or close paths. [A]

**Pencil Tool Options** (double-click the tool) [A]

| Option | Behaviour | Default [U] |
|---|---|---|
| Fidelity | Five-stop slider from Accurate to Smooth. "Controls how far you have to move your mouse or stylus before a new anchor point is added." | middle stop |
| Fill new pencil strokes | Applies the current fill to strokes drawn from then on, not to existing ones. | off |
| Keep selected | The path stays selected after drawing. | on |
| Option/Alt key toggles to Smooth Tool | Holding Alt with the Pencil or Paintbrush switches to Smooth. | off |
| Close paths when ends are within N pixels | On release, auto-closes the path if its ends are within N px; the close cursor shows first. | on, 15 px |
| Edit selected paths / Within N pixels | Allows redraw/merge of a selected path when you start within N px. | on, 12 px |
| Live preview | Renders stroke styles and effects while drawing. | on |
| Live curve fitting | Fits the curve while you draw. When off, fitting happens on mouse-up. Needs Live preview. | on |

- Live preview and Live curve fitting need **New Art Has Basic Appearance** turned off and Preferences > Performance > Real-Time Drawing and Editing turned on. [A]

**Algorithm**
- Adobe publishes nothing on the fitting algorithm. The Pencil was rebuilt in CC 2014, when the five-stop Fidelity slider replaced the older Fidelity (px) / Smoothness (%) fields. [C]
- Fidelity behaves like the distance/error tolerance of a least-squares cubic Bézier fit with corner detection, the class of Schneider's "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990). That is an inference, not an Adobe statement [U].
- The old Smooth tool text defines Fidelity as "movements of less than N pixels aren't registered", range 0.5–20 px, and Smoothness 0–100%. [A-old]

**Smooth tool** (no default key; grouped with the Pencil/Shaper tools)
- Drag along a selected path to smooth it and reduce its anchors. Repeat for more smoothing. [A]
- Options: a slider from Accurate to Smooth. The new doc no longer shows the old Fidelity and Smoothness numbers. [A]
- Source: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/adjust-path-smoothness.html

**Object > Path > Smooth** (Oct 2023 release)
- An on-canvas slider from Minimum to Maximum smoothing, plus an Auto-Smooth button. [A]
- With anchors selected by Direct Selection, only that section is smoothed. [A-old]
- Source: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/refine-path-segments-with-the-smooth-slider.html

**Path Eraser tool** (no default key)
- Select a path, then drag the tool along a segment to erase that part. The result is split into open paths. "For best results, use a single, smooth, dragging motion." [A]
- Source: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/erase-parts-of-a-path.html

**Eraser tool** (Shift+E)
- A different tool: it erases areas of any artwork, closed shapes included. [A]
  - With nothing selected, it erases across all layers.
  - Shift-drag constrains it to horizontal, vertical or diagonal.
  - Alt-drag erases everything inside a marquee.
  - `[` and `]` change the size.
  - Options: Angle, Roundness, Size, each Fixed, Random, Pressure, Stylus Wheel, Tilt, Bearing or Rotation.
- Source: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/erase-paths-using-eraser-tool.html

## 4. Direct Selection tool (A)

Sources:
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/select-anchor-points-in-paths.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/select-path-segments.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/convert-anchor-points-on-a-path.html
- https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/split-paths.html
- Old editing-paths page: https://web.archive.org/web/20241217201043/https://helpx.adobe.com/illustrator/using/editing-paths.html
- https://helpx.adobe.com/illustrator/using/adjust-path-segments.html

**Selecting**
- Click an anchor to select it. Shift-click adds or removes anchors, segments or both. [A]
- Marquee-drag selects the anchors (and segment parts) inside the marquee, from selected or unselected paths. [A]
- Clicking **within 2 px of a segment** selects the segment. [A-old]
- Clicking **inside a filled path** selects all of its anchors. [A-old]
- On hover, a hollow square on the cursor means the anchor is unselected and a filled square means selected. [A-old]
- The Lasso (Q) selects anchors and segments freeform. [A]

**Moving**
- Dragging a selected anchor, segment or handle moves it. Shift constrains to 45°. [A]
- Arrow keys nudge by the Keyboard Increment, and Shift+arrow nudges by 10×. [A]
- Dragging a **straight** segment moves it (both of its anchors). Dragging a **curved** segment reshapes it by changing its handles. [A]
- Shift while reshaping a curve constrains the handles perpendicular and equal, which gives a semicircle. [A]
- Editing an existing smooth point's handle with Direct Selection changes the length on the dragged side only, and the angle stays collinear. When the point is first drawn with the Pen, both sides change together. [A]
- A transform (scale, rotate) can be applied to just the selected anchors. [A]

**Control panel "Anchors" options** (shown when anchors are selected but not whole objects) [A/A-old]
- **Convert selected anchor points to corner** / **to smooth**. These work on several anchors at once. When several objects are selected, at least one must be only partly selected. [A]
- Handles: show or hide handles for multiple selected anchors. [A-old]
- **Remove selected anchor points**: deletes the anchors and keeps the path connected. [A-old]
- **Connect selected end points**: joins two selected endpoints. If they coincide they merge into one anchor; if not, a straight segment is added. The join is always a corner. [A]
- **Cut path at selected anchor points**: splits there. A new anchor is created on top of the original, and one of the two is left selected. [A]
- Align/distribute can act on the selected anchors. [U]
- The Properties panel shows the same Anchors buttons in its Quick Actions area. [U]

**Delete key on an anchor**
- Delete or Backspace (and Edit > Cut or Clear) **removes the anchor and the segments attached to it**, so an interior anchor opens the path at that point. Adobe warns against this and recommends the Delete Anchor Point tool or the "Remove selected anchor points" button instead. [A-old]
- Delete on a selected **segment** removes only that segment. Pressing Delete again removes the rest of the path. [A]

**Other**
- Alt toggles to the Group Selection tool. [A]
- The shortcuts page shows "Switch to last-used selection tool: Ctrl + `" [A as printed], which may be a rendering glitch. Holding Ctrl while in the Pen and other drawing tools gives the last-used selection tool. [A]

## 5. Object > Path submenu

Sources:
- Menu contents and order in CC 2019 (v23), from the executeMenuCommand map: https://github.com/ten-A/AiMenuObject/blob/master/AiMenu_v23.jsxinc
- Join: https://helpx.adobe.com/illustrator/using/adjust-path-segments.html
- Average: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/average-the-position-of-anchor-points.html
- Outline Stroke: https://helpx.adobe.com/illustrator/desktop/paint-and-fill/learn-painting-basics/convert-strokes-to-compound-paths.html
- Offset Path: https://helpx.adobe.com/illustrator/desktop/manage-objects/edit-objects/offset-duplicate-objects.html
- Simplify: https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/simplify-paths-advanced-options-overview.html and https://web.archive.org/web/20241217123732/https://helpx.adobe.com/illustrator/using/simplify_paths.html
- Divide Objects Below and Split Into Grid: https://helpx.adobe.com/illustrator/desktop/manage-objects/edit-objects/divide-or-split-objects.html
- Shortcuts: https://helpx.adobe.com/illustrator/using/default-keyboard-shortcuts.html

**Order**
- The v23 menu map gives: Join, Average, Outline Stroke, Offset Path, Simplify, Add Anchor Points, Remove Anchor Points, Divide Objects Below, Split Into Grid, Clean Up. [A-ish: derived from menu map]
- Current versions add **Reverse Path Direction** and **Smooth** (Oct 2023). Their exact positions are [U]. My best recollection of 2025/2026:

| # | Item | Win / Mac shortcut | Behaviour |
|---|---|---|---|
| 1 | Join | Ctrl+J / Cmd+J [A] | See the Join details below this table. |
| 2 | Average… | Alt+Ctrl+J / Opt+Cmd+J [A] | Dialog with an Axis choice of Horizontal, Vertical or Both. Moves the selected anchors (two or more, on one or several paths) to their average position on that axis. [A] "Horizontal" puts the points on a horizontal line (same Y) [U: Adobe's wording "horizontal (X) axis only" is ambiguous]. |
| 3 | Outline Stroke | none | Turns the stroke into a filled compound path of the stroke's outline. If the object also has a fill, "the resulting Compound Path is grouped with the filled object." [A] |
| 4 | Offset Path… | none | Dialog: **Offset** (signed distance; negative goes inward; shown as 10 px in the doc screenshot), **Joins** (Miter, Round, Bevel), **Miter limit** (4 in the screenshot), Preview. Creates a *new* offset copy and keeps the original. [A] Where the copy sits in the stack is [U]; Zibel puts it directly below, as Inkscape's Linked Offset does (ADR-0039). |
| 5 | Reverse Path Direction | none | Reverses the anchor order, and so the start and end, of the selected paths. Arrowheads, brushes and type on a path flip. [C] Before this command, only compound paths could be reversed, through the Attributes panel. [C] |
| 6 | Simplify… | none [A: none listed] | See the Simplify details below this table. |
| 7 | Smooth | none | On-canvas slider from Minimum to Maximum smoothing, plus Auto-Smooth. Applies to the whole path or to the anchors selected with Direct Selection. [A] Position in the menu [U]. |
| 8 | Add Anchor Points | none | Adds one anchor at the middle of **every** segment of the selected paths, doubling the anchor count without changing the shape. Repeating keeps subdividing. [C/U] |
| 9 | Remove Anchor Points | none | Removes the **selected** anchors and keeps the path connected, with the neighbouring segments refitted like the Delete Anchor Point tool. It is the same as the Control panel's "Remove selected anchor points" and unlike the Delete key. [C] |
| 10 | Divide Objects Below | none | Cookie cutter: the selected object cuts through every object below it that it overlaps, and the cutter is then discarded. [A] Which objects are cut and how the pieces are stored is [U]; Zibel cuts filled shapes in two (ADR-0041). |
| 11 | Split Into Grid… | none | Dialog: Rows (Number, Height, Gutter, Total), Columns (Number, Width, Gutter, Total), Add Guides, Preview. Replaces the selected objects with a grid of rectangles. With several objects selected, the grid uses the topmost object's appearance. [A] |
| 12 | Clean Up… | none | Dialog with three checkboxes, all on by default: Stray Points, Unpainted Objects (no fill and no stroke, and not a mask), Empty Text Paths. Deletes matching objects document-wide. [C] The Adobe page on stray points documents only Select > Object > Stray Points, then Delete. [A] |

**Join** [A]
- **Whole open paths** selected with the Selection tool: Illustrator joins the closest endpoints first and repeats until all the paths are one.
  - If the endpoints don't overlap, it adds a straight bridging segment.
  - A **single** open path selected on its own is **closed**.
  - The result takes the **appearance of the topmost** path.
  - The join is **always a corner**.
- **Two endpoints** selected with Direct Selection: connects them. Coincident endpoints merge into one anchor; separate ones get a straight segment.
  - Selecting anything other than two open endpoints raises the alert "To join, you must select two open endpoints". [C]
- **Shift+Ctrl+Alt+J** (Win) / **Shift+Cmd+Opt+J** (Mac) on overlapping endpoints opens a dialog to choose a Corner or Smooth join.

**Simplify**
- **Object > Path > Simplify** applies an auto-simplified result at once and shows an on-canvas bar [A]:
  - a slider from Minimum to Maximum anchor points, starting at the auto value;
  - an **Auto-Simplify** button;
  - a **More Options** (…) button that opens the dialog.
- The dialog [A]:
  - Simplify Curve slider.
  - **Corner Point Angle Threshold** slider (left is smoother, right is sharper; "the corner point remains unchanged when the threshold is at a value greater than the auto-calculated default threshold (90°)").
  - **Auto-Simplify**.
  - **Convert to Straight Lines** (straight segments between the original anchors).
  - **Show Original Path**.
  - Original/New anchor counts.
  - Preview.
  - "Retain my latest settings and directly open this dialog".
- It works on the whole object, or on a region of anchors selected with Direct Selection. [A]

## 6. Keyboard shortcuts

Source: https://helpx.adobe.com/illustrator/using/default-keyboard-shortcuts.html (last updated Feb 17, 2026). Shortcuts are the same on Windows and macOS unless noted. All [A].

**Tools**

| Tool | Key |
|---|---|
| Pen | P |
| Add Anchor Point | + (plus) |
| Delete Anchor Point | - (minus) |
| Anchor Point (listed as "Switch to Anchor Point tool") | Shift+C |
| Curvature | Shift+~ |
| Pencil | N |
| Shaper | Shift+N |
| Blob Brush | Shift+B |
| Paintbrush | B |
| Eraser | Shift+E |
| Scissors | C |
| Direct Selection | A |
| Selection | V |
| Lasso | Q |
| Line Segment | \ |

- **Smooth, Path Eraser, Knife and Join have no default key.** None of them appears in the shortcuts page's tool table. [A]

**Path commands**

| Command | Windows | macOS |
|---|---|---|
| Join | Ctrl+J | Cmd+J |
| Average | Alt+Ctrl+J | Opt+Cmd+J |
| Corner or smooth join | Shift+Ctrl+Alt+J | Shift+Cmd+Opt+J |
| Make compound path | Ctrl+8 | Cmd+8 |
| Release compound path | Alt+Shift+Ctrl+8 | Opt+Shift+Cmd+8 |

- No other Object > Path item has a default shortcut.

**Drawing modifiers** ("Edit shapes" table)

| Action | Windows | macOS |
|---|---|---|
| Pen tool to Convert Anchor Point tool | Alt | Option |
| Toggle Add and Delete Anchor Point tools | Alt | Option |
| Scissors tool to Add Anchor Point tool | Alt | Option |
| Pencil to Smooth tool (only if the Pencil option is enabled) | Alt | Option |
| Move current anchor point while drawing with the Pen | Spacebar-drag | Spacebar-drag |
| Knife: straight cut | Alt-drag | Option-drag |
| Knife: cut at 45° or 90° | Shift+Alt-drag | Shift+Option-drag |
| Cycle drawing modes | Shift+D | Shift+D |
| Constrain movement to 45° (not with the Reflect tool) | Shift | Shift |
| Toggle Direct Selection and Group Selection | Alt | Option |
| Last-used selection tool | "Ctrl + `" as printed | |

## Open questions to verify in a live Illustrator
1. Does Undo while drawing with the Pen keep the path active, and is the continued path's outgoing handle kept?
2. Does continuing from a smooth endpoint start a straight or a curved segment? (The docs contradict each other.) Not verified live; Zibel starts it straight, because `d` stores no outgoing Handle at an open Endpoint (ADR-0037).
3. Exact positions of Reverse Path Direction and Smooth in Object > Path.
4. The Pencil option defaults (15 px close, 12 px edit, Keep selected on).
5. How the Curvature tool closes a path (clicking the first point?).
6. Where Offset Path puts the new object in the stacking order. Not verified live; Zibel puts it directly below the original, as Inkscape's Linked Offset does (ADR-0039).
7. The Rounded Rectangle tool's Corner Radius default (Preferences > General), which Zibel takes as 12 pt (#143). Also: do Up and Down step from the radius drawn or from the stored one when the box is too small for it, and after Right, is the fully rounded radius what the next drag starts from? Not verified live; Zibel steps from the radius drawn and keeps the one Right drew.
