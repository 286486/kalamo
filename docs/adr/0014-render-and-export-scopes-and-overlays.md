---
status: accepted
date: 2026-09-24
---

# `render` and `export` share one scope; overlays are drawn into the SVG at pixel size

An Agent looks at part of a Document with `kalamo_render` and saves part of it with `kalamo_export` (F-MCP-10, F-MCP-11, REQUIREMENTS §6.4). Both tools take the same scope and build the same SVG serialization; `render` adds overlays and caps the image size, `export` returns the artwork only.

- **Scope.** `scope` is one of `{artboardId}`, `{nodeIds}` or `{rect}`; omitted, it is the whole Document, the union of every Artboard, as before (for an SVG `export`, one Artboard with the others as pages outside it: ADR-0017). The scope fixes `docRect`, the area in document coordinates that the image covers.
  - `{artboardId}`: the Artboard's `frame`. Everything inside it is drawn, and everything outside is clipped away, as Illustrator exports an Artboard. An unknown id is `ARTBOARD_NOT_FOUND`.
  - `{rect}`: `{x, y, width, height}` in document coordinates, drawn like an Artboard.
  - `{nodeIds}`: the union of the listed Nodes' `visibleBounds`, so Strokes are not cut off. Only those Nodes and what they contain are drawn, as Illustrator's Export Selection does; their ancestors still apply their visibility and opacity, so the Nodes look as they do in the Document. An unknown id is `NODE_NOT_FOUND` with its `path`. When the listed Nodes have no bounds (empty Groups), the call fails with `NOTHING_TO_RENDER`.
- **Background.** Artboard backgrounds are part of the Document, so the doc, Artboard and rect scopes draw them where they fall inside `docRect`. The nodeIds scope does not: exporting a selection gives a transparent background. `background` (`#RRGGBB` or `#RRGGBBAA`) fills the whole `docRect` beneath everything, in every scope. Without it, pixels outside every Artboard stay transparent.
- **Size.** `scale` is pixels per point, default 1, at most 4. `render` also takes `maxSize`, default 1600 px: when the longer side of `docRect × scale` exceeds it, `render` lowers the scale until that side is `maxSize`. 1600 px is about what a vision model takes in before it downscales the image itself, so a larger image costs tokens without showing more. `export` has no `maxSize`: it produces the size asked for. Either tool refuses an image whose longer side would exceed 4096 px with `LIMIT_EXCEEDED`, and the hint gives the largest `scale` (or `maxSize`) that fits. `maxSize` has no schema cap; the 4096 px check is the cap. So `render` reaches `LIMIT_EXCEEDED` only when `maxSize` is above 4096, and `export` reaches it at any `scale` large enough.
- **Viewport.** `render` and a PNG `export` return `viewport: {docRect, pixelSize, scale}`, where `scale` is the scale actually used after `maxSize`, so `docX = docRect.x + px / scale` holds for every image. `scale` is the exact zoom the rasteriser draws with. resvg rounds `docRect × scale` to whole pixels and stretches the drawing to fit, so before rasterising, the Durable Object widens `docRect` to `pixelSize / scale` (by less than one pixel, with `pixelSize` rounded up) and serialises that. `viewport.docRect` is the rect the image actually shows. An SVG `export` returns `docRect` only: its `viewBox` is `docRect` and its `width` and `height` are the same numbers in points. (Superseded in part by ADR-0017: at doc scope an SVG `export`'s `viewBox` and `docRect` are one Artboard's frame, the one at (0,0), else the first, because Inkscape resizes the page at (0,0) to the `viewBox`.)
- **Overlays.** `render` takes `overlays`, any of `bounds`, `ids` and `artboards`, default none. They are drawn into the SVG serialization after the artwork, before rasterising, so resvg draws them with the same font and transform as everything else. They are sized in pixels, not points: the Durable Object knows the final scale, so it writes a 1 px line as `stroke-width = 1 / scale` and 11 px labels as `font-size = 11 / scale`, readable at any scale.
  - `bounds`: the `geometricBounds` of every drawn Node except Layers, which would frame the whole drawing; Groups are included, since Agents address them.
  - `ids`: each of those Nodes' id as a label at the top-left corner of its `geometricBounds`, with a white halo so it reads on any colour.
  - `artboards`: each Artboard's `frame` as a line in a colour distinct from `bounds`.
  - Hidden Nodes, and Nodes outside the nodeIds scope, get no overlay.
- **Formats.** `export` takes `format: "svg" | "png"` (and `kalamo_json` with #13) and returns the result inline: SVG as text content, PNG as image content. Overlays never appear in an export; it is the artwork the Agent hands on. (Amended by ADR-0099: Template Layers do not appear in an export either, though `render` draws them.)

## Considered Options

- **nodeIds draws everything inside the Nodes' bounds**: shows context, but the image then includes whatever overlaps the Nodes, which is not what "look at this Group" means. The rect scope already gives context: pass the Nodes' bounds as a `rect`.
- **`maxSize` as a hard limit that fails instead of scaling down**: an Agent would have to compute a scale for every large Document before it can see it. Scaling down and reporting the scale used keeps the pixel mapping exact.
- **Overlays in the browser's Canvas2D or as a second image**: two renderers would have to agree on overlay placement, and the Agent would have to align two images. Drawing them into the one SVG keeps a single rendering path (F-MCP-02).
- **`vector-effect="non-scaling-stroke"` for overlay lines**: the SVG way to keep 1 px lines, but resvg support is not something the tests can rely on, and the scale is known when the SVG is built.

## Consequences

- `ARTBOARD_NOT_FOUND` and `NOTHING_TO_RENDER` join the error codes.
- The Durable Object builds the SVG for a known scale, so the render limits are checked there, before the Worker rasterises.
- With 26-character ULIDs, `ids` labels overlap in a dense grid; an Agent narrows the scope to read them. Shorter display ids can come later without changing the scope or the viewport.
