---
status: accepted
date: 2026-09-29
---

# A painted Clipping Path draws its Fill behind the content and its Stroke in front

Illustrator empties a Clipping Path's Appearance on Make and lets the designer give it Fills and Strokes back (F-MASK-01). It draws the Fill behind the clipped content and the Stroke in front, centred on the path, and the Stroke's outer half is not clipped. A frame around a cropped photo is drawn this way. ADR-0021 stores such an Appearance but draws none of it, and in `<clipPath>` export writes only the first Fill and Stroke (#50). This ADR amends ADR-0021 so that the Appearance is drawn.

## What it paints

A Clipping Mask Group draws, bottom to top:

1. the Group's container paints below Contents (ADR-0043), clipped;
2. the Clipping Path's Fills, in order, as a leaf paints them, clipped (the clip changes no pixel of a Fill, since the Fill is inside its own outline);
3. the other children, clipped, as before;
4. the Clipping Path's Strokes, in order, as a leaf paints them, **not** clipped by the Group's own Clipping Path, so the full width shows;
5. the Group's container paints above Contents, clipped.

In Illustrator's Appearance panel, the Clipping Path's Fill and Stroke belong to the Group's **Contents**, so items 2 to 4 are Contents. An ancestor's Clipping Mask still clips every item, the Strokes included.

- **Opacity and blend mode.** A Clipping Path's `opacity` and `blendMode` now apply to its paints, as an object's do in Illustrator. The Fills and the Strokes are two separate parts with the content between them, so each part composites on its own under ADR-0044: a part that paints more than once takes a layer, and a part that paints once draws directly. The clip itself ignores them, as SVG's `<clipPath>` does.
- **Hidden.** This is unchanged. A Clipping Path cannot be hidden (ADR-0021).
- **Make and Release.** Make still empties the Appearance, as Illustrator's Make does. Release keeps whatever Appearance the path has, and the released Path draws as an ordinary leaf.
- **Container Appearance.** `paintedLeaves` still skips Clipping Paths, so an ancestor's container paint does not outline one (ADR-0043).

## Bounds and hit test

`geometricBounds` of a Clipping Mask stays its Clipping Path's geometric bounds. `visibleBounds` becomes the Clipping Path's own `visibleBounds` as a leaf's, so a Stroke grows it by half the widest Stroke. The WriteReceipt, `doc_outline`, the Render Overlays and a `nodeIds` Render Scope all follow `visibleBounds`.

On the canvas, a click on a painted Fill or Stroke of the Clipping Path hits it, including the Stroke's outer half outside the clip. The Selection tool then picks the Clipping Mask, and Direct Selection picks the Clipping Path. An unpainted Clipping Path still hits nothing, as before.

## SVG

This changes ADR-0021's rule, "a repainted Clipping Path writes only its first Fill and Stroke". The element inside `<clipPath>` now carries only geometry, `clip-rule` and `fill="none"`. The paint is written like a container's (ADR-0043): as locked derived copies, each inside a `<g>` that carries the paint.

- **Fills.** When the Clipping Path has Fills, the Group's clipped `<g>` holds a `<g zibel:paint="clip-fill" sodipodi:insensitive="true" inkscape:label="Clipping Path Fill">` right after the container paints below Contents. That group holds one copy of the Clipping Path with its Fills only and no id, written as a leaf writes that Appearance: one element, or a `<g zibel:stack>`, in the Clipping Path's own `transform`, with its gradients in a `<defs>` just before the group (ADR-0026).
- **Strokes.** When the Clipping Path has Strokes, the Group's own `<g>` keeps its id, label, lock, `transform`, `opacity` and `mix-blend-mode`, but drops `clip-path`. Its children become a `<g zibel:clipped="true" clip-path="url(#clip-z-<id>)">` holding items 1 to 3, with the inline `<clipPath>` at its place among them, then `<g zibel:paint="clip-stroke" sodipodi:insensitive="true" inkscape:label="Clipping Path Stroke">` holding a copy with the Strokes only, as the Fill copy is written, and then, only when there are container paints above Contents, a second `<g zibel:clipped>` naming the same `<clipPath>` that holds them. A Clipping Path without Strokes keeps ADR-0021's single `<g clip-path>`, so every file written before this change opens and exports unchanged.
- **Opacity.** The Clipping Path's `opacity` and `mix-blend-mode` are written on each part's `<g zibel:paint>`.

Inkscape 1.2.2 keeps this structure when it saves a file: the wrappers, the `zibel:` attributes, the inline `<clipPath>` in place, and both references to one `<clipPath>`. It adds an id to each wrapper and each copy, and the import ignores those ids. This was checked with `inkscape --actions` on a hand-written file.

Import reads the pieces back:

- Within a `<g>` read as a Group, each direct child `<g zibel:clipped>` is not a Node. Its children are read as the Group's children, in place, and its `clip-path` is read as the Group's Clipping Mask under ADR-0021's rules. When the wrappers name different `<clipPath>`s, or when the Group's `<g>` also has a `clip-path`, the import keeps the first clip it meets and warns `UNSUPPORTED_ATTRIBUTE` `clip-path`.
- A `<g zibel:paint="clip-fill">` or `"clip-stroke"` gives the Clipping Path its Fills or its Strokes. The import reads that paint from the copy by a leaf's rules, the copy's `transform` included. It also reads the group's `opacity` and `mix-blend-mode` as the Clipping Path's (they are equal on both parts, and the first part read wins). It ignores the copy's geometry, which comes from the `<clipPath>`. When a designer deletes a part in Inkscape, that part's paints are gone. The Fill group is not counted in Contents (ADR-0043). A clip paint group whose Group has no Clipping Path is dropped with `UNSUPPORTED_ELEMENT`.
- The element inside a `<clipPath>` gives no paint. SVG never draws that paint, and Inkscape's Set Clip keeps the clipped object's old style there, so reading it would draw a black Fill behind every foreign clip. A Clipping Path read from any file without clip paint groups has an empty Appearance. Without this rule, the same file would render differently in Zibel than in Inkscape.

`render` draws the SVG through resvg, so it follows this mapping. The canvas draws the five items above in the same order, from the same Nodes.

## Considered Options

- **The Stroke inside the clipped `<g>`.** Only the inner half of the Stroke would show, which is not how Illustrator draws a Clipping Path's Stroke.
- **The Stroke as a sibling after the Group's `<g>`, which keeps `clip-path` on the Group.** It would sit outside the Group's opacity and blend mode, and above the container paints above Contents. It would also need an id reference to pair it back to its Group.
- **Always the wrapper form.** A single rule, but every existing Clipping Mask would export differently, and Inkscape's Object > Clip > Release, run on the Group, would find no clip to release. The wrapper is used only when a Stroke needs it.
- **Paint on the element inside `<clipPath>`**, as today. A `<clipPath>` cannot hold a `<g zibel:stack>` or `<defs>`, and nothing there is drawn, so no other SVG viewer shows the paint.
- **Keep opacity and blend mode undrawn**, as ADR-0021 does. Then the designer sets them and sees nothing change, whereas Illustrator applies an object's opacity to its own paints.

## Consequences

- The render fixture's hash changes once, when the fixture gains a painted Clipping Mask.
- F-MASK-01 no longer lists "a repainted Appearance is drawn" as deferred. CONTEXT.md's Clipping Path entry no longer says it is never drawn.
- A text Clipping Path (#49) and a Layer Clipping Mask (#51) take this rule as they land: a text's copies are `<text>` as ADR-0043 writes them, and a Layer's `<g inkscape:groupmode="layer">` wraps like a Group's.
