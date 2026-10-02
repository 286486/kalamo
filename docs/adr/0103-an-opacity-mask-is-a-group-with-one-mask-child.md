---
status: accepted
date: 2026-10-02
---

# An Opacity Mask is a Group with one mask child

Designers fade artwork with Opacity Masks: Illustrator's Transparency panel Make Mask, with its Clip, Invert Mask and link options (F-MASK-02). Inkscape writes one as `mask` on the masked object, so the round trip (ADR-0017) needs them (#55). ADR-0021 left `kalamo_mask_make`'s `kind: "opacity"` refused. This ADR models the Opacity Mask the way ADR-0021 models the Clipping Mask, and amends ADR-0021's `kind` line.

## What Illustrator does

- **Make.** With the mask object on top of the selection, Make Mask turns the topmost object into the mask of the rest. The mask keeps its paint, since its luminance is what masks: white shows the art, black hides it, grey is partly transparent. The mask's own opacity multiplies in.
- **Clip** (on for a new mask by default). The mask gets a black background, so art outside the mask object is hidden. With Clip off, art outside the mask object shows at full opacity.
- **Invert Mask** (off by default). The mask's luminance is reversed inside the mask object. The background Clip adds stays black.
- **Link** (on by default). Moving or transforming the masked art moves the mask with it. Unlinked, the mask stays where it is. Moving the mask alone, in the mask editing mode, never moves the art.
- **Release.** The mask becomes an ordinary object again, painted where it sits.
- **Bounds.** The selection bounds of masked art are the art's, not the mask's.

Adobe's help pages refuse automated fetches. This record rests on Illustrator's documented behaviour of the Transparency panel, on its scripting DOM, and on common practice, as ADR-0052 does.

## The rule

- **The tree.** A Node but a Layer gains `opacityMask: {clip, invert, link}`. A Group with such a child is an Opacity Mask, and that child is its mask, as `clipping` makes a Clipping Path (ADR-0021). A Live Shape, a Path, a text, an Image or a Group can be the mask. A Group has at most one mask child, and never both a mask child and a Clipping Path: nest one Group in the other instead. A Layer has none. The mask cannot be hidden (`INVALID_PATCH`), as a Clipping Path cannot, because SVG hides everything through a hidden mask. `doc_open` refuses a file that breaks these rules (ADR-0016), and a commit rechecks them (ADR-0072). A missing `opacityMask` means none, so no migration.
- **Where it sits.** Its place among its siblings does not change what is drawn. Make keeps every member's stacking order. Import puts it where the file had it. A mask moved to another parent, pasted, or duplicated alone loses `opacityMask` and paints again, as a Clipping Path loses `clipping` (ADR-0071, ADR-0076).
- **Luminance.** Nothing paints the mask. Its pixels, with its own Appearance, opacity and blend mode, become the content's alpha: `0.2125 R + 0.7154 G + 0.0721 B` on the sRGB values, times the mask's alpha. These are the coefficients resvg and Inkscape 1.2.2 apply to an SVG luminance `<mask>`, both measured equal within one level for red, green, blue, 50% grey and 50% white. Illustrator converts to grayscale through its colour profile, which differs slightly; matching the round-trip renderers wins, as ADR-0022 decided for text.
- **Clip off** composes the mask over white: content outside the mask Node shows. **Invert** reverses the mask Node's own colour before that, `1 − L` where it paints, and leaves its alpha alone. So with Clip and Invert both on, content outside the mask is still hidden, and with Clip off and Invert on, the mask cuts a hole: `alpha = (invert ? 1 − L : L) · a + (clip ? 0 : 1 − a)`.
- **Link.** A `node_transform` whose targets include the Opacity Mask Group or one of its ancestors transforms a linked mask with the content and leaves an unlinked one where it is. Naming the mask itself moves only the mask. Naming a content child never moves the mask.
- **Bounds.** An Opacity Mask's `geometricBounds` and `visibleBounds` are its content's, without the mask child. The WriteReceipt, `doc_outline`, Render Overlays and a `nodeIds` Render Scope follow. A container's Appearance (ADR-0043) paints no copy of the mask or what it holds.
- **Container Appearance.** The Opacity Mask Group's own Appearance is masked with its children. An ancestor container's Appearance paints copies of the masked leaves unmasked: the copy is drawn outside the Group. Masking those copies waits until a file needs it.

## Tools

- **`kalamo_mask_make {docId, clipNodeId, contentIds[], kind: "opacity", clip?, invert?}`**, as REQUIREMENTS §6.4 names `invert?`. `clipNodeId` is the mask. The sibling and containment rules, the new Group at the topmost member's place and the kept stacking order are those of `kind: "clip"` (ADR-0021). Make keeps the mask's Appearance. `clip` defaults to true, `invert` to false, and `link` starts true. Each refusal is `INVALID_MASK`: a Layer as the mask, a hidden mask, a mask or content Node that already is a Clipping Path or a mask, `clip` or `invert` with `kind: "clip"`, and `layerId` with `kind: "opacity"`.
- **`kalamo_node_update`** merge-patches the mask's `opacityMask.clip`, `.invert` and `.link`: the Transparency panel's checkboxes and link icon. Adding `opacityMask` to a Node is `INVALID_PATCH` with a hint to use `mask_make`; `opacityMask: null` is `INVALID_PATCH` with a hint to use `mask_release`.
- **`kalamo_mask_release`** takes the Group's id or the mask's, removes `opacityMask` and leaves the Group and the mask, now painted at its place. Its refusal names both mask kinds.
- Each is one Transaction, and undo reverses it.

## SVG

Export writes the Group as `<g mask="url(#mask-z-<id>)">` with an inline `<mask maskUnits="userSpaceOnUse">` at the mask's place among the children, as ADR-0021 places `<clipPath>`. Inkscape 1.2.2 keeps it there, with its `kalamo:` attributes. The `<mask>` holds the mask Node as its own element and id. Its region is the content's visible bounds grown by 10% on each side, SVG's own default margin, so a Stroke's miter spikes stay inside.

- **Clip off** writes `<rect kalamo:mask="background" fill="#FFFFFF">` over the region, first in the `<mask>`.
- **Invert** wraps the mask Node in `<g kalamo:mask="invert" filter="url(#invert-z-<id>)">`, a `<filter color-interpolation-filters="sRGB">` over the region holding one `feColorMatrix` that maps each colour channel `c` to `1 − c` and keeps alpha. sRGB, because the default linearRGB would not invert the luminance above. resvg and Inkscape draw it alike.
- **Unlinked** writes `kalamo:mask="unlinked"` on the `<mask>`. SVG has no link, and a viewer ignores the attribute.

Import reads a `mask` on a `<g>` as that Group's Opacity Mask and a `mask` on a leaf as a new Group of the leaf's Nodes with the mask on top, as ADR-0021 imports a `clip-path`. One element in the `<mask>` is the mask Node, and several become a Group that is. The three markers read back as Clip off, Invert and unlinked, and the background rect and the wrapper are not Nodes. A foreign `<mask>` imports with Clip on, Invert off and Link on; its region is not kept, since export writes its own. These still import unmasked with `UNSUPPORTED_ATTRIBUTE` `mask`: a missing reference, `maskContentUnits="objectBoundingBox"`, `mask-type: alpha`, a `<mask>` that draws nothing, a `mask` on a Layer, and a `mask` beside a `clip-path` on one element.

## Drawing

`render` draws through resvg from the exported SVG. The browser canvas draws the Opacity Mask Group as an isolated layer in ADR-0044's sense: its content into one layer, the mask into another, which `getImageData` turns into the alpha above, and the two composed with `destination-in` before the result composites in the Group's opacity and mode, inside every ancestor's clip.

## Considered Options

- **An `opacityMask` field on the Group naming its mask by id.** A dangling id after a delete, and a second place that says which Node is the mask. The flag on the child is the pattern ADR-0021 already uses.
- **The mask outside the Group, in `<defs>`, as Inkscape's Set Mask writes it.** The mask would be no Node of the tree and unreachable by `node_get` and `node_transform`.
- **Illustrator's own grayscale conversion.** `render` and Inkscape would disagree with the canvas on every grey.
- **Invert as an `<feComponentTransfer>` table.** The same pixels; `feColorMatrix` is one element both renderers have drawn the same in the measurement above.

## Consequences

- REQUIREMENTS F-MASK-02 and §6.4's `mask_make` row cite this ADR; F-IO-01's `mask` maps both ways.
- The Transparency panel, editing the mask on the canvas, hit testing and Layers panel names for Opacity Masks are separate work.
- A Node stored before this change has no `opacityMask`, and every reader takes a missing one as none.
