---
status: accepted
date: 2026-09-29
---

# An isolated layer that reaches far is bounded by a filter region

ADR-0054 leaves out of `render`'s SVG every Node far outside the rendered rect, because resvg panics on an isolated layer outside its fixed band. That band also applies to nested layers, and there the cull does not help (#129).

## The nested band

resvg clamps each isolated layer to `IntRect(-2w, -2h, 4w, 4h)`, where w × h is the image size, and unwraps the result (`fit_to_rect`, `crates/resvg/src/geom.rs`). For a nested layer it applies the same box in the parent layer's pixel coordinates, whose origin is the parent layer's top-left corner, not the image's. The parent layer can start up to 2w left of the image. So a nested layer panics when its left edge lies more than 2w right of where its parent layer starts, even when it lies inside the image. When it straddles that line, resvg cuts it off there with no error.

Measured on `@resvg/resvg-wasm` 2.6.2, 100 × 100 px:

- A translucent Group holding a rect at x = -500, 520 wide, and a translucent 20 × 20 rect at (30, 30) panics. With the first rect at x = -100 it draws, and at x = -110 it panics.
- With the far rect at x = -150, a nested translucent rect from x = 30 to 80 draws only columns 30 to 47.
- `clip-path` does not bound a layer. resvg sizes a layer from its children's unclipped boxes, so clipping the far child, the parent, or a `<g>` around the parent still panics, and so does a near Clipping Path over far content holding a translucent child.
- A filter region does bound a layer. resvg sizes a filtered group's layer from its filter region, not from its children. An identity filter (`<feOffset/>`, `filterUnits="userSpaceOnUse"`, `color-interpolation-filters="sRGB"`) whose region is the image grown by half a side fixes each case above, three-deep nesting and the vertical axis. Each draws byte-identical to the same SVG with its far part moved in. With no far content, the filter draws byte-identical to no filter, with and without `clip-path`, with gradients with alpha, text, and `opacity` with `mix-blend-mode`, at zoom 1 and 3.
- The nested layer must be near too. Under a filtered parent, a translucent rect at x = 140 draws, and one at x = 160 panics.
- A sweep of the rule below over image sides of 1 to 100 px, with the parent's first child from -50w to 4w and the nested rect from -4w to 4w, rendered 128,142 SVGs with no panic. Under ADR-0054's cull alone, 194,313 of 230,202 panicked.

## The rule

`toSvg`'s `resvg` option, which `renderSvg` always passes, derives three rects from the rendered rect, after `fit` widens it to whole pixels, per axis:

| Rect | Margin on each side | Used for |
| --- | --- | --- |
| Cull rect (ADR-0054) | one side | Nodes not inside any isolated `<g>` |
| Bound rect | half a side | the filter test and the filter region |
| Inner cull rect | a quarter side | Nodes inside any isolated `<g>` |

- **Isolated `<g>`.** A group element io writes that resvg composes as a layer: a Layer or Group with `opacity < 1` or a non-normal `blendMode` (ADR-0044), a Clipping Mask of either kind (ADR-0021, ADR-0053), the `<g zibel:clipped>` wrapper around a painted Clipping Path's content (ADR-0051), and the `<g clip-path>` around a container Appearance's copy of a leaf inside an inner Clipping Mask (ADR-0043).
- **Inner cull.** Inside an isolated `<g>`, at any depth, a Node whose `visibleBounds` misses the inner cull rect is left out, as ADR-0054 leaves out one that misses the cull rect.
- **Bound.** An isolated `<g>` gets `filter="url(#bound)"` when what its layer holds is not inside the bound rect. What its layer holds is the union of the `visibleBounds` of the children it writes, the painted Clipping Path when it paints, and the copies its Appearance paints of kept leaves, each grown by half its widest Stroke. It is not the container's own `visibleBounds`, which a Clipping Mask clips. A Clipping Path inside `<clipPath>` does not count. The wrapper around a copy is judged by that copy. Leaf layers get no filter: they hold no nested layers, and the inner cull keeps them in the band.
- **Filter.** One `<filter id="bound">` in a `<defs>` before the artwork, written only when some `<g>` uses it: `<feOffset/>`, `filterUnits="userSpaceOnUse"`, `color-interpolation-filters="sRGB"`, and the bound rect as its region. Containers carry no transform (ADR-0007), so their user space is the root's. Node ids start with `z-`, so `bound` cannot collide with one.

`toSvg` without `resvg`, which `export` SVG and Download SVG call, is unchanged byte for byte. A test pins its output for every isolated kind.

## Why these margins

A nested layer's left edge, less its parent layer's, must stay under 2w. A filtered parent layer starts at the bound rect, -w/2. An unfiltered parent's contents lie inside the bound rect, so it starts no further left than about -w/2. A nested layer meets the inner cull rect, so its left edge is below 1.25w. That gives about 1.75w, with a quarter side of headroom for `visibleBounds` underestimates (ADR-0054) and resvg's 2 px anti-aliasing padding. The same holds on the other side and on the y axis.

## Pixels stay exact

- The filter clips only what lies past the bound rect, half a side outside the image.
- The inner cull leaves out only Nodes whose `visibleBounds` lies at least a quarter side outside the image. A pixel inside the image changes only if `visibleBounds` underestimates by more than a quarter side: ADR-0054's argument with a smaller margin, inside isolated containers only.
- A filtered layer is at most 2w × 2h px. An unfiltered far layer is at most 4w × 4h px after resvg's own clamp, so memory per far layer goes down.

## Considered Options

- **`clip-path` on the container or on the far child.** Measured: it does not bound the layer.
- **Split the geometry of far-reaching leaves.** Paths, Strokes, texts and Images would each need clipping code, for the same pixels.
- **A filter on every isolated `<g>`.** Each layer would be 4× the image: 256 MB at 4096 px.
- **Pad each isolated group (ADR-0054).** A pad stretches a layer's box but cannot shrink it.
- **Patch resvg's wasm.** A Rust toolchain and a fork to maintain, when the filter does the job with the pinned package.
- **`toSvg` takes the rendered rect.** The rendered rect is the viewBox `toSvg` already has, so a boolean derives all three rects from it and cannot disagree with it.

## Consequences

- The rule depends on resvg sizing a filtered layer from its filter region. A test in `far.test.ts` renders a filtered far-left parent with a nested Node inside the image, and fails naming this ADR if a resvg upgrade changes that.
- The rule stays after an upstream fix, like ADR-0054's. It costs one bounds union per isolated `<g>` and draws nothing extra. The upstream bug is that `fit_to_rect`'s box is not moved into a layer's own coordinates; it is worth reporting against linebender/resvg.
- Opacity Masks (#55) will add a `<g mask>`, another isolated `<g>`, that must follow this rule.
