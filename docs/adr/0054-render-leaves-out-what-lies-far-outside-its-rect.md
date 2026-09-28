---
status: accepted
date: 2026-09-29
---

# `render` leaves out what lies far outside its rect

`zibel_render` and PNG `zibel_export` rasterise io's SVG with resvg (ADR-0019). resvg panics, as `RuntimeError: unreachable` in wasm, on an isolated Node whose content lies far outside the image (#128). An isolated Node is one with `opacity < 1` or a non-normal `blendMode` (ADR-0044), a Clipping Mask of either kind (ADR-0021, ADR-0053), or a container of one. A plain shape never panics, wherever it is. So a Document with one translucent shape on each of two Artboards cannot be rendered one Artboard at a time. The same thing happens with a rect scope, with artwork off every Artboard at doc scope, and with a `nodeIds` Clipping Mask whose content lies far from its Clipping Path.

## The panic

resvg draws each isolated Node into its own layer. It clamps the layer's pixel box to `IntRect(-2w, -2h, 4w, 4h)`, where w × h is the image size, and unwraps the result (`fit_to_rect`, `crates/resvg/src/geom.rs`). A layer whose box misses that region panics. The region reaches two image sides past the left and top edges, but only one side past the right and bottom edges. Measured on a 100 × 100 image, with 3 × 3 translucent content: x from -200 to 200 draws, and x = 210 panics. y behaves the same way. The band scales with each axis on its own. The pinned 2.6.2, the newest prerelease 2.7.0-alpha.2 and native `@resvg/resvg-js` 2.6.2 all panic.

## The rule

- **The cull rect.** It is the rendered rect, after `fit` widens it to whole pixels, grown by its own width on the left and right and by its own height above and below.
- **What is left out.** The SVG that `render` rasterises leaves out every Node whose `visibleBounds` misses the cull rect or is null. The test runs at every depth. A container that is left out takes its whole subtree with it. A leaf is left out on its own inside a container that stays. A Clipping Path is never judged on its own: it is written whenever its Clipping Mask is. A container's Appearance paints only copies of the leaves that stay (ADR-0043). A copy of a far leaf inside an inner Clipping Mask is wrapped in a `<g clip-path>`, an isolated layer of its own, and panics like the leaf would.
- **What else.** Nodes that are left out are not drawn, so the `bounds` and `ids` Render Overlays skip them. The `artboards` overlay, Artboard backgrounds and the `background` option are plain rects, and they stay as they are.
- **Where.** io's `toSvg` takes the cull rect as its `cull` option and applies it in its Node walk. `renderSvg` always passes it. `renderSvg` is the one SVG behind both `zibel_render` and PNG `zibel_export`. `toSvg` without `cull`, which is what `export` SVG and Download SVG call, is unchanged byte for byte.

## Why one image side

- **Not zero.** `visibleBounds` can underestimate what a Node paints: miter spikes, square caps and non-uniform scale all reach further. With a margin of one image side, every pixel inside the rect stays exact as long as the underestimate is smaller than the image.
- **Not more.** A Node that stays meets the cull rect, so its layer meets resvg's region. On the right and bottom, the cull rect's edge and resvg's edge are the same line, one side out, so the margin cannot grow.
- **Per axis.** resvg's band is per axis. Growing both axes by the longer side would let a wide, short image keep Nodes that resvg rejects.

A copy that a container's Stroke paints for a leaf that was left out could reach into the rect only if that Stroke were wider than two image sides. That copy is left out too.

## Considered Options

- **Upgrade or pin resvg.** Every available build panics.
- **Leave out only Clipping Masks.** This was the first guess in #128. Translucent and blended Nodes panic the same way.
- **Cull at the exact rect.** This gives the underestimates of `visibleBounds` no margin, and loses edge pixels.
- **Catch the panic and return a Zibel error.** The image still fails. A wasm panic can also leave the module instance unusable for later renders in the isolate.
- **Pad each isolated group with an invisible element that stretches its box onto the canvas.** It is pixel-neutral in theory. But it changes the SVG of every isolated Node, not only the far ones, and it depends on resvg internals. A pad stretches a layer's box but cannot shrink it, so it cannot keep a far-reaching parent layer's nested layers in its band either. ADR-0055 bounds the far-reaching ones with a filter region instead.

## Consequences

- ADR-0019's "`render` and `export` share one serializer" becomes "one serializer, with render's far-Node cull".
- The rule stays after an upstream fix. It keeps the rasterised SVG small, and it costs one bounds check per Node.
- resvg applies the same fixed box to a nested layer in its parent layer's pixel coordinates. So a nested isolated Node can still panic when its isolated parent reaches more than about one side past the left or top of the image, even when both meet the cull rect (#129). ADR-0055 bounds such parents and culls harder inside isolated containers. `toSvg`'s `cull` option became `resvg`, which derives this cull rect with ADR-0055's.
