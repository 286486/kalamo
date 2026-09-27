---
status: accepted
date: 2026-09-27
---

# A translucent or blended Node composes as one image

The browser canvas multiplied a Node's opacity into every paint of every descendant and set its blend mode on each paint, so a 50% Group of two overlapping opaque rects showed a darker lens where they overlap, and a half-transparent rect showed its Fill through the inner half of its Stroke. `render`, SVG export and every SVG viewer compose the Group first and fade it once. ADR-0038 already relies on that ("a Node's opacity and blend mode apply to the whole Node"), and Illustrator's object opacity and blending agree with it. An Agent that checks its work with `render` must see what the person sees (#111).

## The rule

It is SVG and CSS compositing:

- **Isolated Nodes.** A Node with `opacity < 1` or `blendMode` other than `normal` is an isolated group. Its contents compose onto a transparent backdrop, and the result composites once onto its parent's backdrop with alpha `opacity` and the Node's blend mode. A container at opacity 1 and normal is not isolated, so its children blend with everything below it.
- **Which take a layer.** On the canvas every visible isolated Layer and Group draws into an offscreen layer. So does an isolated leaf that paints more than once: more than one Fill and Stroke in total, or any text, since glyphs overlap and ranges paint per character. A leaf that paints once, and an Image, draw directly with `globalAlpha` and `globalCompositeOperation`: one paint composited directly gives the same pixels as through a layer, and a Document of many translucent single-paint shapes keeps its cost.
- **Inside a layer** everything draws at alpha 1 in `source-over`, except a descendant's own opacity and blend mode, which follow the same rule. Nested isolated Nodes each get their own layer. A hidden Node draws nothing and asks for no layer.
- **Coordinates and clips.** A layer is the target's device size and starts in the target's current transform, so leaves draw on the same device pixels. The Node's own Clipping Path clips inside the layer. The layer composites under the identity transform while the target's state stays in force, so every ancestor's clip still applies and a layer never paints outside an ancestor's Clipping Path.
- **Backdrop.** A top-level Layer blends with what the Viewer drew before the Document: the Artboard backgrounds, white under an Artboard without one. Outside the Artboards the canvas is transparent over the page's pasteboard.
- **Container Appearance.** When the canvas draws a container's Fills and Strokes (#105), they draw inside its layer, below or above Contents, as SVG puts them inside the container's `<g>` (ADR-0043).

`render` and SVG export already follow this rule and do not change.

## Interface

`@zibel/render` is type-checked for workerd, which has no DOM, so it cannot make a canvas. `drawDocument(ctx, doc, layer, images?)` takes a `NewLayer`: a function that returns a fresh, transparent `Canvas2D` of the target's device size with the image to hand to `drawImage`. `Canvas2D` gains `getTransform` and the three-argument `drawImage`, declared structurally. The Viewer backs it with a DOM canvas, which uses the Document's loaded fonts.

A layer covers the whole canvas; cropping it to the Node's visible bounds in device space, or reusing layers, is the upgrade if translucent containers show up in a profile.

## Considered Options

- **Per paint, as before.** Cheap, and wrong wherever two paints of one isolated Node overlap.
- **A layer for every isolated Node, leaves included.** Correct, but a full-canvas layer for each translucent rect costs a Document of many of them for no change in pixels.
- **A layer the size of the Node's bounds.** Less memory, but needs visible bounds in device space for every isolated Node, including Clipping Masks and text; left for when a profile asks for it.
