---
status: accepted
date: 2026-09-29
---

# Illustrator's `<use>` clips are read as an editable Clipping Path, one per Clip Group

Illustrator's Save As SVG does not put a Clipping Path inside `<clipPath>`. It writes the shape once in `<defs>` and points to it with `<clipPath><use xlink:href="#SVGID_1_"/></clipPath>`. It also writes `clip-path` on each child of a Clip Group instead of on the group, and it draws a painted Clipping Path's Fill and Stroke with more `<use>`s of the same shape. In 85 Illustrator files on GitHub (CS6 to 2024), 211 of 229 `<clipPath>`s hold exactly one `<use>`. ADR-0021 holds only a shape, path or text inside `<clipPath>` (ADR-0052), so every one of these clips was dropped with `UNSUPPORTED_ATTRIBUTE` `clip-path`, and the paint `<use>`s with `UNSUPPORTED_ELEMENT` `use` (#127). This ADR amends ADR-0021 and ADR-0051 on import. Export does not change.

## The copy rule

A `<clipPath>` whose one child, after silent elements, is a `<use>` is held when, besides ADR-0021's rules (no `objectBoundingBox`, no `clip-path` on the `<clipPath>`):

- its `href`, else its `xlink:href`, is a same-file `#id` in the reader's id map;
- the target is a `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `path` or `text`, and a text holds no `textPath`;
- neither the `<use>` nor its target has a `clip-path`;
- `x` and `y` are absent or plain lengths. `width` and `height` only size a `<symbol>` or `<svg>`, and are ignored.

Resolution is one step. SVG 1.1 lets a `<use>` in a `<clipPath>` name only a shape or text, and browsers draw nothing for anything else. A `<use>` that names another `<use>`, a `<g>`, a `<symbol>`, itself or its own `<clipPath>` never reaches a shape, so it is refused without a cycle check. A refused clip keeps ADR-0021's warning, whose text now names "a `<use>` that does not point to one shape, path or text in this file".

A held `<use>` is read exactly as its target would be if it were copied into the `<clipPath>` in its place, so ADR-0021's, ADR-0051's and ADR-0052's rules for the inline form carry over:

- **Coordinates.** The referencing element's user space, then the `<clipPath>`'s `transform`, then the `<use>`'s `transform`, then `translate(x, y)`, then the target's own `transform`. This is SVG's order for a `<use>`. Where the target sits in the file, in `<defs>` or in a transformed `<g>`, adds nothing.
- **Style.** The copy inherits from the `<use>`, which inherits from the `<clipPath>`. The target's own attributes, `style` and matching rules win. Only `clip-rule` and a text's font properties shape a clip. Paint is ignored, as for any element inside a `<clipPath>` (ADR-0051), and `overflow` is ignored without a warning.
- **Identity.** The Clipping Path stands for the `<use>`: it takes the `<use>`'s id (a `z-<ULID>` is kept, any other id is new), its `inkscape:label`, and its tags and metadata. It never takes the target's id, because the target may also be drawn, or be shared by several clips and paint `<use>`s. Reading a clip never consumes its target: a target in `<defs>` stays silent, and one in drawn content still imports as its own Node. Each held clip makes its own Clipping Path.

## One Clip Group from per-child clips

A `<g>` read as a Group is the Clip Group itself, with its Clipping Path on top, when:

- it is not an Inkscape layer;
- it has no `clip-path` of its own and no `<g zibel:clipped>` wrapper, so the Zibel and Inkscape forms keep their rules;
- it has at least one drawn child, and every drawn child names the same holdable `<clipPath>`, inline or through a `<use>`;
- every such child's own `transform` is identity within Illustrator's rounding: linear terms within 1e-6 and translation within 1e-3 user units. Illustrator writes matrices such as `matrix(1 0 2.980232e-08 1 -3.051758e-05 -3.051758e-05)` on clipped groups.

Its children then import without their `clip-path`, each keeping its own tiny transform; only the clip is read in the `<g>`'s space. In every other case a clipped `<g>` is a Clip Group and a clipped leaf gets a Clip Group of its own, as ADR-0021 says. In the sample, 147 of the 149 elements that share a `<clipPath>` with siblings share it with every drawn sibling.

Merging on a Layer, across non-siblings, or across different `<clipPath>`s with equal geometry is not done. Illustrator writes its layers as plain `<g>`s, so its Layer clipping masks arrive as Groups.

## Illustrator's painted Clipping Path

In a `<g>` merged through a `<use>` clip, a sibling `<use>` is the Clipping Path's paint when it names the same target, has no `clip-path`, and its `transform`, `x` and `y` give the same matrix as the clip `<use>` with its `<clipPath>`'s `transform`. That is ADR-0051's order:

- one before the first clipped child gives its Fills to the Clipping Path's Fills, in order;
- one after the last clipped child gives its Strokes to its Strokes, in order.

Each is read as ADR-0051 reads a clip paint group's copy: the target copied in the `<use>`'s place, its gradients in the copy's space, and the Clipping Path's `opacity` and blend mode from the first one read. A Stroke on a `<use>` before the content, a Fill on one after it, and a paint `<use>` between clipped children are dropped with one `UNSUPPORTED_ATTRIBUTE` `clip-path paint` warning. Paint `<use>`s make no Node. Any other drawn `<use>` keeps `UNSUPPORTED_ELEMENT` `use`: general `<use>` import (F-IO-01's `use`, F-LIVE-01 Symbols) is out of scope.

## Layers

A layer `<g>`'s own `clip-path` goes through the same check, so a `<use>` clip gives a Layer Clipping Mask under ADR-0053, its Clipping Path at the `<clipPath>`'s place when the `<clipPath>` is inline and on top when it is in `<defs>`. The merge and paint rules apply to Groups only.

## Evidence

Illustrator was not run; Adobe's help pages refuse automated fetches. The forms come from real Save As SVG and Export As files in public GitHub repos, counted by script (#127). `<use>` targets were paths (89), rects (64), polygons (36), ellipses (14), polylines (5) and circles (3); none was a `<use>`, `<g>` or `<symbol>`, and none was missing. Two targets carried their own rotation. 25 drawn `<use>`s repaint clip geometry, with gradients among the paints. Export As writes the shape directly in `<clipPath>` with `clip-path` set through a CSS class, which ADR-0021 already holds. A text as a `<use>` target was not observed; it follows by the copy rule and ADR-0052. Inkscape's re-save of such a file adds `id` and `x="0" y="0" width="100%" height="100%"` to the `<use>`, which holds.

## Considered Options

- **Keep refusing `<use>` clips.** Every Clipping Mask in an Illustrator SVG would keep spilling its content, and the file would not look as it does in Illustrator.
- **Resolve `<use>` generally, as a clone Node.** Zibel has no Symbol or clone Node yet (F-LIVE-01). Holding the clip needs only the copy rule.
- **The target's id on the Clipping Path.** The target can be drawn, or shared by several clips and paint `<use>`s, so its id would collide.
- **One Clip Group per clipped child**, as ADR-0021 reads Inkscape's Set Clip. Each Illustrator Clip Group would open as one Clip Group per object, and the designer would edit many masks where Illustrator shows one.
- **An exact identity test for the merge.** Illustrator's rounding matrices would split its own Clip Groups.

## Consequences

- Open, Place and SVG paste share the reader, so all three get these clips. Core, render, the canvas, hit testing and export do not change: the result is an ordinary Clip Group or Layer Clipping Mask, and export writes ADR-0021's and ADR-0051's inline form, which reads back as the same Nodes.
- A `<g>` whose every drawn child names one `<clipPath>`, which opened as one Clip Group per child before, now opens as one Clip Group. Zibel's and Inkscape's own exports never write this form for a Group.
- ADR-0053's note that Illustrator's `<use>` clips import unclipped is replaced by this ADR.
