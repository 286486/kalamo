---
status: accepted
date: 2026-09-27
---

# Offset Path adds its copy directly below the original, previewed by PathKit in the browser

Object > Path > Offset Path (F-PATH-03, #88) keeps the original and adds an offset copy (research 06 §5). Adobe's documentation does not say where the copy goes in the stacking order (research 06, open question 6), and forum threads and tutorials do not either. The dialog has a Preview, and ADR-0034 kept PathKit out of the browser until something needed it.

## Decision

**`path_op offset {distance, join, miterLimit}` adds one path per path or Live Shape, directly below it in the same parent.** Inkscape's Linked Offset does this: `sp_selected_path_create_offset_object` (`src/path/path-offset.cpp`, 1.2.x) inserts the new object at the original's position with `addChildAtPos(repr, pos)`, which pushes the original one step up. Inkscape stacks it this way for positive and negative offsets alike. The copy below leaves the original visible and editable on top, where it was, and a grown copy then reads as an outline around it.

- The copy is the original's path, keeping its appearance, name, transform, opacity and blend mode, with a new id, the offset `d` and fill rule evenodd. Skia's result has no overlapping contours, but it can wind a hole the same way as the outline around it: growing a C shape until its gap closes leaves a hole that nonzero would paint. A Live Shape stays live and its copy is a path, so there is no `CONVERTED_TO_PATH`.
- `distance` is in document units: the path is offset in document coordinates and brought back into its own, so a scaled path's copy is still `distance` away on the page. `join` defaults to miter and `miterLimit` to 4, Illustrator's dialog defaults.
- The geometry is ADR-0034's: the fill united with, or minus, a stroke twice the distance wide with butt caps. An open subpath is filled as if closed, as Illustrator fills one.
- A Clipping Path gets no copy, since a second one would change what the group clips. A path that shrinks away also gets none. The call fails with `INVALID_PATH` when no copy is left, and without a `distance`.

**The browser loads PathKit for the Preview.** `@zibel/geometry` splits into the ops on a loaded PathKit (`geometry.ts`), the Worker's loader (`index.ts`, the statically imported module as before) and the browser's (`browser.ts`, which fetches the `.wasm` by its Vite URL). The web app imports `@zibel/geometry/browser` dynamically the first time Preview is checked, so the entry chunk is unchanged: `check:bundle` now greps only `index-*.js` for PathKit. The preview runs core's `pathOp` with that geometry on a copy of the Document, as Simplify's does (ADR-0035), and OK sends one `path_op` that the Document DO commits.

**The Worker bundle defines `__dirname`.** Under `nodejs_compat`, PathKit's Emscripten loader sees `process.versions.node`, takes the Worker for Node and reads `__dirname`, which an ES module Worker does not have. `wrangler dev` failed there on every geometry op, Outline Stroke included, while the vitest pool, which shims `__dirname`, passed. `apps/edge/wrangler.jsonc` defines it as `"/"`. The loader never reads a file, because the wasm is handed to `instantiateWasm`.

## Consequences

- The first Preview downloads about 150 KB gzipped (the chunk and the `.wasm`). The preview computes in float32, like the commit.
- Selection stays on the originals after OK. Illustrator's behaviour here is not checked.
- Stacking and Illustrator's handling of open paths should be checked in a live Illustrator when one is available.
